/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * vectorSources.ts — the SINGLE business → engine translation seam for vector
 * layer sources.
 *
 * ARCHITECTURAL IDENTITY — this file owns the vector-source REGISTRY: the
 * vocabulary of pixel-production strategies, the contributor contract, and the
 * dispatcher that consults it. The engine itself knows NO tool: each tool
 * (built-in or plugin) contributes a translator (pure: `Layer` payload →
 * engine-neutral `LayerSource`) and the dispatcher walks the registry until one
 * recognizes the layer. Built-in strategies (stroke, text) self-register at
 * module load below; plugin tools register through the plugin registry
 * (`core/plugin/registry.ts`), which forwards every plugin's
 * `contributions.engine.vectorSource` — so importing that registry is
 * sufficient to have ALL contributors in place before the first scene
 * assembly (production, engine tests, and headless pipelines alike).
 *
 * Registration contract: translators are non-overlapping — a contributor
 * returns `undefined` for any layer whose payload it does not own, and the
 * dispatcher takes the first non-`undefined` result. No dispatch ordering
 * guarantee exists or is needed; a new tool therefore plugs in with ZERO
 * edits to this file.
 *
 * Source vocabulary (engine pixel-production strategies, NOT tool identities):
 *   • `sdf`    — analytic primitive fragment solve (consumed today by the
 *     marker plugin's rect/ellipse/arrow shapes)
 *   • `stroke` — compute-extruded ribbon from a packed point stream (vector brush)
 *   • `text`   — GPU glyph quads over a coverage atlas (text; CPU layout runs in
 *     the translator, the GPU side never re-computes layout)
 *
 * All colours are converted ONCE into the document WORKING gamut (ProPhoto RGB)
 * linear light via `toWorkingLinearRgba`; the shared drawLayer tail applies
 * layer opacity / blend downstream for every strategy alike.
 *
 * @module core/engine/pipeline/scene/vectorSources
 */

import type { Layer, StrokeData, WorkingColorSpace } from '@opengpex/editor/core/types';
import { toWorkingLinearRgba } from '@opengpex/editor/core/engine/color';
import {
  computeTextLayout,
  type TextMeasureContext,
} from '@opengpex/editor/core/engine/text/textLayout';
import type { LayerSource, StrokeParams } from './Scene';

// Re-exported: the contributor contract's input/output types travel with it.
export type { LayerSource };

// ─── stroke → point stream (vector brush) ───────────────────────────────────

/** Float32 lanes per packed point: [x, y, width, _pad] (mirrors the WGSL `Pt`). */
const FLOATS_PER_POINT = 4;

/**
 * Re-base a stroke's box-local geometry into the PARENT layer's local space.
 *
 * A committed `StrokeData` stores its trajectory and frozen selection snapshot
 * relative to its OWN box (`StrokeData.box`, in layer-local coordinates — i.e.
 * offsets from the layer bounding's top-left). The same shift applies to the
 * trajectory and to the confinement rings, keeping the pairing invariant
 * (points and snapshot land in ONE coordinate frame).
 */
function strokeBoxToLayerOffset(strokeBox: {
  readonly x: number;
  readonly y: number;
}): { readonly dx: number; readonly dy: number } {
  return { dx: strokeBox.x, dy: strokeBox.y };
}

/** Pack one stroke's trajectory into the `Pt` stream the extrude compute reads. */
function packStrokePoints(
  data: StrokeData,
  dx: number,
  dy: number,
): { readonly points: Float32Array; readonly pointCount: number } {
  // Pack the trajectory into [x, y, width, alpha] × N — the exact `Pt` layout
  // `cs_extrude` reads.
  //
  // WIDTH LANE: the compute pass extrudes `half-width = lane * 0.5` and has no
  // access to the paint uniform's `size`, so the EFFECTIVE TIP DIAMETER
  // (`size × pressure`) has to ride the point stream. Packing raw 0..1 pressure here
  // would render every stroke as a ≤1px hairline regardless of the brush size.
  // ALPHA LANE: the per-point paint-opacity multiplier (pressure-opacity
  // dynamics); absent samples read as 1 (full opacity).
  const pointCount = data.points.length;
  const points = new Float32Array(pointCount * FLOATS_PER_POINT);
  for (let i = 0; i < pointCount; i++) {
    const p = data.points[i];
    const base = i * FLOATS_PER_POINT;
    points[base + 0] = p.x + dx;
    points[base + 1] = p.y + dy;
    points[base + 2] = data.size * p.pressure;
    points[base + 3] = p.alpha ?? 1;
  }
  return { points, pointCount };
}

/**
 * Map a logic-brush layer to a `vector` {@link LayerSource} (`renderer: 'stroke'`),
 * or `undefined` if the layer carries no stroke payload.
 *
 * A collection layer (`Layer.strokes`) maps EVERY stroke to its own
 * {@link StrokeParams}: each stroke extrudes and draws separately, but they all
 * render into the layer's ONE shared transient (the strokes composite into each
 * other inside the layer, then the layer composites once). The in-drag payload
 * (`strokeData`, the gesture layer's live trajectory) maps as a one-element
 * collection; its points are canvas coordinates, so the box offset is zero.
 *
 * `workingSpace` is the document compositing gamut (always `WORKING_GAMUT`,
 * ProPhoto RGB — see `SceneAssembler` invariant). `width`/`height` are read from the
 * layer's BOUNDING box (`layer.bounding.w/h`): they become the `LayerNode.width/height`
 * the compositor places the quad at, and the StrokeRenderer's vertex shader divides the
 * logical-pixel trajectory by them to reach NDC (see {@link StrokeParams.width}).
 */
export function strokeToVectorSource(
  layer: Layer,
  workingSpace: WorkingColorSpace,
): LayerSource | undefined {
  if (layer.type !== 'vector') return undefined;
  const strokesData: readonly StrokeData[] | undefined = layer.strokes ?? (layer.strokeData ? [layer.strokeData] : undefined);
  if (!strokesData || strokesData.length === 0) return undefined;

  const w = Math.max(1, layer.bounding?.w ?? 0);
  const h = Math.max(1, layer.bounding?.h ?? 0);
  const params = strokesData.map((data) => {
    // Straight-alpha working-gamut linear rgba (never premultiplied here — the
    // StrokeRenderer emits STRAIGHT alpha and the shared drawLayer tail applies
    // layer.opacity / blend downstream).
    const color = toWorkingLinearRgba(data.color, workingSpace);
    // Legacy strokes carry no box (points were layer-local).
    const { dx, dy } = data.box
      ? strokeBoxToLayerOffset(data.box)
      : { dx: 0, dy: 0 };
    const { points, pointCount } = packStrokePoints(data, dx, dy);

    return {
      points,
      pointCount,
      color: [color[0], color[1], color[2], color[3]] as [number, number, number, number],
      size: data.size,
      hardness: data.hardness,
      // Normalize: undefined = AA on (zero-regression default for legacy strokes).
      antiAliased: data.antiAliased !== false,
      width: w,
      height: h,
      // Frozen selection snapshot (box-local, travels with the stroke, re-based
      // into layer space by the same box shift as the trajectory). The vector
      // spine bakes it into a coverage texture and the paint fragment
      // multiplies by it — the stroke only paints inside its selection.
      confinement: data.confinement
        ? {
            rings: data.confinement.rings.map((ring) =>
              ring.map((p) => [p.x + dx, p.y + dy] as [number, number]),
            ),
            antiAliased: data.confinement.antiAliased !== false,
          }
        : undefined,
    } satisfies StrokeParams;
  });

  return {
    kind: 'vector',
    renderer: 'stroke',
    strokes: params,
  };
}

/**
 * O(1)-per-stroke change fingerprint for a stroke collection's packed
 * trajectories — the composite-once cache key for the stroke source. Lives
 * HERE, not in `compositeSignature.ts`, because its validity is a WRITER
 * CONTRACT of this renderer: it must flip on every mutation the packed
 * trajectories can undergo, and only this domain knows who writes it.
 *
 * WHY THIS SHAPE IS SOUND — the writer contract: within one stroke's packed
 * trajectory (`[x, y, width, alpha] × N`) the writers are the live drag on the
 * gesture's own layer (APPEND flips pointCount; TAIL-PREVIEW REPLACE rewrites
 * the last sample, including a stationary stylus changing ONLY its pressure or
 * alpha) and the pointerup tighten, which rebuilds the payload in place
 * (pointCount changes when taper densification inserts samples; bounding moves
 * flip the LayerNode tokens anyway, and undo/redo replaces the whole layer
 * object). So a per-stroke (pointCount, first point, last point) token
 * plus the stroke COUNT sees every mutation; the array walk is O(stroke count),
 * which is tens at worst and cheap against the serialized-trajectory costs it
 * guards. The first point's width/alpha lanes are technically redundant (the
 * first sample is immutable during a drag) and kept anyway — they future-proof
 * the token against new writers.
 *
 * Scalar brush attributes (colour / size / hardness / antiAliased), the
 * bounding extent, and each stroke's confinement presence ride the token so
 * undo/redo restoration and parameter edits flip the signature too.
 *
 * Degenerate shapes: `pointCount <= 0` yields a fixed token with NO index
 * arithmetic; `pointCount === 1` reads first and last at the SAME offset, which
 * is valid. The token is recomputed against the LIVE params every frame by the
 * composite signature — the trajectory buffer is mutated in place while the
 * assembled LayerNode is reused across frames, so a build-time string would go
 * stale; per-frame recomputation is exactly the cost this shape was chosen for.
 */
export function strokeSourceFingerprint(strokes: readonly StrokeParams[]): string {
  const lanes: string[] = ['vector:stroke', String(strokes.length)];
  for (const stroke of strokes) {
    const { points, pointCount, color, size, hardness, antiAliased, width, height } = stroke;
    // Confinement lane: the snapshot is written once at stroke creation and is
    // immutable for the stroke's lifetime, so a presence bit suffices as the
    // writer contract (a future writer that mutates a frozen snapshot must
    // extend this token — same rule as for the packed trajectory).
    const confLane = stroke.confinement ? 'conf' : '-';
    if (pointCount <= 0) {
      lanes.push(`0:-:${size}:${hardness}:${antiAliased ? 1 : 0}:${color.join(',')}:${width}x${height}:${confLane}`);
      continue;
    }
    const lastBase = (pointCount - 1) * 4;
    lanes.push([
      pointCount,
      `${points[0]},${points[1]},${points[2]},${points[3]}`,
      `${points[lastBase]},${points[lastBase + 1]},${points[lastBase + 2]},${points[lastBase + 3]}`,
      `${size}:${hardness}:${antiAliased ? 1 : 0}:${color.join(',')}:${width}x${height}:${confLane}`,
    ].join('|'));
  }
  return lanes.join(':');
}

// ─── text → glyph layout ────────────────────────────────────────────────────

/**
 * Shared offscreen measuring surface (Canvas2D satisfies `TextMeasureContext`
 * structurally). Lazily created; `undefined` when no DOM canvas is available —
 * the translator then reports the layer as not mappable.
 */
let sharedMeasureContext: TextMeasureContext | undefined;

function getMeasureContext(): TextMeasureContext | undefined {
  if (sharedMeasureContext) return sharedMeasureContext;
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  sharedMeasureContext = ctx as unknown as TextMeasureContext;
  return sharedMeasureContext;
}

/**
 * Map a text layer to a `vector` {@link LayerSource} (`renderer: 'text'`), or
 * `undefined` when the layer is not a GPU-text candidate: no `textData`, wrong
 * layer type, or no measure surface in the current environment.
 *
 * `workingSpace` is the document compositing gamut (always `WORKING_GAMUT`,
 * ProPhoto RGB — see `SceneAssembler` invariant). The layout is computed at
 * `layer.bounding` (the same extent the compositor places the quad at); the
 * GPU-side density multiplication and atlas banding happen in `TextRenderer`.
 *
 * `measureContext` is injectable for tests; production uses the shared
 * offscreen canvas above.
 */
export function textToVectorSource(
  layer: Layer,
  workingSpace: WorkingColorSpace,
  measureContext?: TextMeasureContext,
): LayerSource | undefined {
  const data = layer.textData;
  if (!data || layer.type !== 'text') return undefined;
  const mc = measureContext ?? getMeasureContext();
  if (!mc) return undefined;

  const w = Math.max(1, layer.bounding?.w ?? 0);
  const h = Math.max(1, layer.bounding?.h ?? 0);

  const layout = computeTextLayout(mc, data, w, h);

  // Straight-alpha working-gamut linear rgba (the shared drawLayer tail applies
  // layer.opacity / blend downstream, exactly as for the other strategies).
  const color = data.color ? toWorkingLinearRgba(data.color, workingSpace) : ([0, 0, 0, 1] as const);

  return {
    kind: 'vector',
    renderer: 'text',
    text: {
      layout,
      fontKey: `${data.fontFamily}|${data.fontWeight || 400}|${data.italic ? 1 : 0}`,
      fontFamily: data.fontFamily,
      fontSize: data.fontSize || 24,
      fontWeight: data.fontWeight || 400,
      italic: data.italic === true,
      color,
      width: w,
      height: h,
    },
  };
}

// ─── contributor registry (the one routing point) ───────────────────────────

/** Per-strategy extras forwarded to translators; each picks what it needs. */
export interface VectorSourceOptions {
  /** Explicit bounding dims (SDF translators take them explicitly; stroke/text read `layer.bounding`). */
  readonly width?: number;
  readonly height?: number;
  /** Injectable measure surface (text; tests only — production uses the shared canvas). */
  readonly measureContext?: TextMeasureContext;
}

/** Everything a translator may need to translate one layer. */
export interface VectorSourceContext {
  /** Document compositing gamut (always WORKING_GAMUT — see SceneAssembler invariant). */
  readonly workingSpace: WorkingColorSpace;
  /** Explicit bounding dims (required by SDF translators; missing ⇒ the caller
   *  silently misplaces the shape — SceneAssembler always supplies them). */
  readonly width?: number;
  readonly height?: number;
  /** Injectable measure surface (text; tests only). */
  readonly measureContext?: TextMeasureContext;
}

/** A vector tool's entire exposure to the engine: one pure translator. */
export interface VectorSourceContributor {
  /** Registration/dedup key; engine dispatch logic never branches on it. */
  readonly toolId: string;
  /** Translate a business layer into an engine-neutral source, or `undefined`
   *  for layers whose payload this tool does not own (non-overlap contract). */
  translate(layer: Layer, ctx: VectorSourceContext): LayerSource | undefined;
}

/** Engine-side extension slots carried on a plugin under
 *  `contributions.engine`. Each slot's registry anchor lives in this module
 *  (the seam that consumes it). */
export interface EngineContribution {
  readonly vectorSource?: VectorSourceContributor;
}

const contributors = new Map<string, VectorSourceContributor>();

/** Register a contributor (idempotent by toolId; later registration wins).
 *  Returns the unregister function. Plugin contributors are wired by
 *  `core/plugin/registry.ts`; built-in engine strategies self-register at this
 *  module's load below. */
export function registerVectorSourceContributor(c: VectorSourceContributor): () => void {
  contributors.set(c.toolId, c);
  // Identity-checked removal: an unregister from an OVERWRITTEN registration
  // must not evict the newer contributor that now owns the key.
  return () => {
    if (contributors.get(c.toolId) === c) contributors.delete(c.toolId);
  };
}

/** Test-only teardown: drop every contributor (including built-ins). */
export function resetVectorSourceContributorsForTest(): void {
  contributors.clear();
}

/**
 * Translate a business layer into an engine-neutral vector {@link LayerSource}
 * by walking the contributor registry. Translators are non-overlapping (each
 * returns `undefined` for foreign payloads), so first non-`undefined` wins and
 * no ordering guarantee is needed. `undefined` overall ⇒ the caller falls
 * through to the ordinary raster path (this dispatcher never fabricates a
 * bitmap branch).
 */
export function layerToVectorSource(
  layer: Layer,
  workingSpace: WorkingColorSpace,
  opts?: VectorSourceOptions,
): LayerSource | undefined {
  const ctx: VectorSourceContext = { workingSpace, ...opts };
  for (const c of contributors.values()) {
    const src = c.translate(layer, ctx);
    if (src) return src;
  }
  return undefined;
}

// Built-in engine strategies: translators live here, registered through the
// same registry as plugin contributors (module load = registration, so any
// importer of this module always sees them).
registerVectorSourceContributor({
  toolId: 'stroke',
  translate: (layer, ctx) => strokeToVectorSource(layer, ctx.workingSpace),
});
registerVectorSourceContributor({
  toolId: 'text',
  translate: (layer, ctx) => textToVectorSource(layer, ctx.workingSpace, ctx.measureContext),
});
