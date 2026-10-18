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

import type { Layer, WorkingColorSpace } from '@opengpex/editor/core/types';
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
 * Map a logic-brush layer to a `vector` {@link LayerSource} (`renderer: 'stroke'`),
 * or `undefined` if the layer carries no `strokeData`.
 *
 * `workingSpace` is the document compositing gamut (always `WORKING_GAMUT`,
 * ProPhoto RGB — see `SceneAssembler` invariant). `width`/`height` are read from the
 * layer's BOUNDING box (`layer.bounding.w/h`, same source the SDF translators take via `ctx.width/height`)
 * `SdfShapeParams.size`): they become the `LayerNode.width/height` the compositor
 * places the quad at, and the StrokeRenderer's vertex shader divides the logical-pixel
 * trajectory by them to reach NDC (see {@link StrokeParams.width}).
 */
export function strokeToVectorSource(
  layer: Layer,
  workingSpace: WorkingColorSpace,
): LayerSource | undefined {
  const data = layer.strokeData;
  if (!data || layer.type !== 'vector') return undefined;

  const w = Math.max(1, layer.bounding?.w ?? 0);
  const h = Math.max(1, layer.bounding?.h ?? 0);

  // Straight-alpha working-gamut linear rgba (never premultiplied here — the
  // StrokeRenderer emits STRAIGHT alpha and the shared drawLayer tail applies
  // layer.opacity / blend downstream).
  const color = toWorkingLinearRgba(data.color, workingSpace);

  // Pack the trajectory into [x, y, width, _pad] × N — the exact `Pt` layout
  // `cs_extrude` reads. `_pad` stays 0 (WGSL struct alignment lane).
  //
  // WIDTH LANE: the compute pass extrudes `half-width = lane * 0.5` and has no
  // access to the paint uniform's `size`, so the EFFECTIVE TIP DIAMETER
  // (`size × pressure`) has to ride the point stream. Packing raw 0..1 pressure here
  // would render every stroke as a ≤1px hairline regardless of the brush size.
  const pointCount = data.points.length;
  const points = new Float32Array(pointCount * FLOATS_PER_POINT);
  for (let i = 0; i < pointCount; i++) {
    const p = data.points[i];
    const base = i * FLOATS_PER_POINT;
    points[base + 0] = p.x;
    points[base + 1] = p.y;
    points[base + 2] = data.size * p.pressure;
    points[base + 3] = 0;
  }

  return {
    kind: 'vector',
    renderer: 'stroke',
    stroke: {
      points,
      pointCount,
      color,
      size: data.size,
      hardness: data.hardness,
      // Normalize: undefined = AA on (zero-regression default for legacy strokes).
      antiAliased: data.antiAliased !== false,
      width: w,
      height: h,
    },
  };
}

/**
 * O(1) change fingerprint for a live stroke's packed trajectory — the
 * composite-once cache key for the stroke source. Lives HERE, not in
 * `compositeSignature.ts`, because its validity is a WRITER CONTRACT of this
 * renderer: it must flip on every mutation the packed trajectory can undergo,
 * and only this domain knows who writes it.
 *
 * WHY O(1) IS SOUND — the writer contract: the packed trajectory
 * (`[x, y, width, _pad] × N`, lane 2 = size × pressure) only ever changes in
 * three ways across its whole lifetime, and each is visible to a fingerprint of
 * (pointCount, first point, last point):
 *   1. APPEND while dragging — pointCount changes.
 *   2. TAIL-PREVIEW REPLACE — the last sample is re-written in place as the
 *      pointer moves (or as a stationary stylus changes ONLY its pressure:
 *      pointermove may deliver identical coordinates with a new pressure value,
 *      and pressure rides the width lane, so the lane MUST be fingerprinted or
 *      that frame never re-composites).
 *   3. COMMIT TIGHTEN — the trajectory is rebuilt once at pointer-up
 *      (pixel-identical by contract); pointCount / last point / bounding
 *      width/height move, and the LayerNode transform/bounding tokens flip the
 *      layer signature regardless.
 * There is NO writer that rewrites a mid-trajectory point. Any future writer
 * that mutates geometry the fingerprint cannot see (mid-point edits, lane 3,
 * reordering) would silently skip re-compositing — a new writer must either
 * touch one of the fingerprinted quantities or extend this token.
 *
 * Scalar brush attributes (colour / size / hardness / antiAliased) and the
 * bounding extent are included so undo/redo layer restoration and parameter
 * edits flip the signature too; bounding width/height also disambiguate the
 * commit-tighten rebuild. The first point's width lane is technically redundant
 * (the first sample is immutable during a drag) and is kept anyway — it costs
 * nothing and future-proofs the token against new writers.
 *
 * Degenerate shapes: `pointCount === 0` (unreachable via {@link strokeToVectorSource}
 * — layer creation requires ≥1 sample — but kept total) yields a fixed token with
 * NO index arithmetic; `pointCount === 1` reads first and last at the SAME
 * offset, which is valid. The token is recomputed against the LIVE params every
 * frame by the composite signature — the trajectory buffer is mutated in place
 * while the assembled LayerNode is reused across frames, so a build-time string
 * would go stale; O(1) per frame is exactly the cost this shape was chosen for.
 */
export function strokeSourceFingerprint(stroke: StrokeParams): string {
  const { points, pointCount, color, size, hardness, antiAliased, width, height } = stroke;
  if (pointCount <= 0) {
    return `vector:stroke:0:-:${size}:${hardness}:${antiAliased ? 1 : 0}:${color.join(',')}:${width}x${height}`;
  }
  const lastBase = (pointCount - 1) * 4;
  return [
    'vector:stroke',
    pointCount,
    `${points[0]},${points[1]},${points[2]}`,
    `${points[lastBase]},${points[lastBase + 1]},${points[lastBase + 2]}`,
    `${size}:${hardness}:${antiAliased ? 1 : 0}:${color.join(',')}:${width}x${height}`,
  ].join(':');
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
