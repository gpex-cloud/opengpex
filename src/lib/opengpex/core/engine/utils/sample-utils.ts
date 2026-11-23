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
 * sample-utils — the LAZY terminal encode for `SampledPixels`.
 *
 * `capture()` hands back the raw premultiplied-linear working-gamut readback and
 * nothing else. Everything display-facing — un-premultiply, gamut matrix, target
 * TRC, 8-bit quantization — happens HERE, over the tiny block the eyedropper is
 * actually looking at.
 *
 * WHY THIS MODULE EXISTS: encoding the whole ROI up front cost 1.3s of
 * main-thread `Math.pow` on a 4096×4096 snapshot (663ms f32 + 636ms 8-bit,
 * measured) plus ~330MB of transient buffers, all to answer "what colour is the
 * pixel under the cursor" — a 5×5 window, 25 texels, per mouse move. Deferring
 * costs that 5×5 gather per sample and is microseconds.
 *
 * WHERE IT LIVES: `engine/utils/` — this is a PURE CPU pixel helper (no device,
 * no dispatcher, no graph), sibling to `pixel-utils`, and it is imported directly
 * by UI-layer consumers (the sampler overlay, the mosaic brush) the same way
 * `pixel-utils` already is.
 *
 * WHAT IS NOT DEFERRED: the colour math. This calls the same
 * `unpremultiplyEncodeGamutF32` / `unpremultiplyEncodeGamut` helpers the eager
 * path did, with the same arguments, so the single-encode-point
 * invariant and the golden contract
 * `Math.round(float[i] * 255) === rgb8[i]` (exportEncode.test.ts) still hold
 * verbatim — block extraction is a pure re-indexing.
 */

import { WORKING_GAMUT } from '@opengpex/editor/core/engine/color/gamut';
import {
  unpremultiplyEncodeGamut,
  unpremultiplyEncodeGamutF32,
} from '@opengpex/editor/core/engine/utils/readback-utils';
import { toDisplayTrackCanvasColorSpace } from './pixel-utils';
import type { SampledPixels } from '../types';
import { Point2D, Layer, StrokeData, PenPathData, PenLayerStyle } from '@opengpex/editor/core/types';
import { isPointInPathRings } from '@opengpex/editor/core/geometry/operators/point2d';
import { penPathToCubicSegments, flattenCubicChain } from '@opengpex/editor/core/geometry/operators/bezier';
import { imageBitmapCache } from '../sources/ImageBitmapCache';
import { layerToVectorSource } from '@opengpex/editor/core/engine/pipeline/scene/translators';

/**
 * A decoded rectangle of a {@link SampledPixels}, both tracks, in SNAPSHOT
 * pixel coordinates.
 *
 * `x`/`y`/`w`/`h` are the requested rect CLIPPED to the snapshot, so they may be
 * smaller than asked for near an edge. Index either track with
 * `((py - y) * w + (px - x)) * 4` using snapshot-space `px`/`py` — never with the
 * snapshot's own `width`.
 */
export interface SampledBlock {
  /** Clipped block origin in snapshot pixels. */
  readonly x: number;
  readonly y: number;
  /** Clipped block size in snapshot pixels (`>= 1`). */
  readonly w: number;
  readonly h: number;
  /** Center texel X in snapshot pixels. */
  readonly cx: number;
  /** Center texel Y in snapshot pixels. */
  readonly cy: number;
  /** Byte/channel offset of the center pixel within `float` and `rgb8` (`((cy - y) * w + (cx - x)) * 4`). */
  readonly centerIndex: number;
  /**
   * PRECISION TRUTH: straight, document-gamut, TRC-encoded, un-quantized RGBA
   * (`w*h*4`). The sampler's `float` / CSS `color()` readout reads this — never
   * reconstruct it from {@link rgb8}.
   */
  readonly float: Float32Array;
  /**
   * DISPLAY TRACK: 8-bit RGBA (`w*h*4`) clamped to a canvas-representable gamut
   * — magnifier swatches + hex/rgb8 fallback only, NOT a precision source.
   */
  readonly rgb8: Uint8ClampedArray;
}

/**
 * Sample GPU RAW snapshot pixels at a document WORLD position.
 *
 * Folds world-to-texel projection (`(world - bounds.origin) * scale`), bounds coverage
 * check, window clipping, and lazy dual-track terminal encode (precision float + 8-bit
 * display) into a single call.
 *
 * @param cap Snapshot from `pixels.render.capture()`.
 * @param worldX Target position X in document world coordinates.
 * @param worldY Target position Y in document world coordinates.
 * @param radius Sampling window radius in texels (default 0 = 1×1 pixel, 2 = 5×5 magnifier window).
 * @returns The gathered block with center pixel metadata, or `null` if the center pixel
 *          falls outside the snapshot coverage.
 */
export function sampleGpuRawData(
  cap: SampledPixels,
  worldX: number,
  worldY: number,
  radius: number = 0,
): SampledBlock | null {
  const { linearPixels, width, height, gamut, bounds, scale } = cap;

  // World point → snapshot TEXEL index, folding in origin and scale.
  const cx = Math.floor((worldX - bounds.x) * scale);
  const cy = Math.floor((worldY - bounds.y) * scale);

  // Center pixel must fall inside snapshot coverage.
  if (cx < 0 || cy < 0 || cx >= width || cy >= height) {
    return null;
  }

  const r = Math.max(0, Math.floor(radius));
  const ox = cx - r;
  const oy = cy - r;
  const rw = r * 2 + 1;
  const rh = r * 2 + 1;

  // Clip the request window to the snapshot.
  const x = Math.max(0, ox);
  const y = Math.max(0, oy);
  const w = Math.min(width, ox + rw) - x;
  const h = Math.min(height, oy + rh) - y;
  if (w <= 0 || h <= 0) return null;

  // Gather the sub-rect into a contiguous w×h RGBA buffer: the encoders take a
  // packed `width*height*4` buffer, and a row-strided view is not that.
  const rowFloats = w * 4;
  const src = new Float32Array(rowFloats * h);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * width + x) * 4;
    src.set(linearPixels.subarray(from, from + rowFloats), row * rowFloats);
  }

  // Both encoders are pure (each allocates its own output), so one gathered
  // `src` feeds both passes.
  const float = unpremultiplyEncodeGamutF32(src, w, h, {
    sourceGamut: WORKING_GAMUT,
    targetGamut: gamut,
  });
  const rgb8 = unpremultiplyEncodeGamut(src, w, h, {
    sourceGamut: WORKING_GAMUT,
    // Display track: clamp to what a canvas can actually tag (see pixel-utils).
    targetGamut: toDisplayTrackCanvasColorSpace(gamut),
    bitDepth: 8,
  }) as Uint8ClampedArray;

  const centerIndex = ((cy - y) * w + (cx - x)) * 4;

  return { x, y, w, h, cx, cy, centerIndex, float, rgb8 };
}

/**
 * EAGER whole-snapshot encode → display-track `ImageData`.
 *
 * ONLY for callers that genuinely consume every pixel — the mosaic brush, which
 * block-averages the entire composite once per stroke session. This is the exact
 * cost {@link sampleGpuRawData} exists to avoid (hundreds of ms of `Math.pow`
 * on a large snapshot), so do NOT reach for it on an interactive path: an
 * eyedropper wants a 5×5 block, not 16 million pixels.
 *
 * The 8-bit track only, tagged with the canvas colour space the display track was
 * encoded for — `ImageData` cannot carry `adobe-rgb`/`prophoto-rgb`, so wide-gamut
 * documents land in `display-p3` exactly as the old eager `capture()` produced them.
 */
export function sampleImageData(cap: SampledPixels): ImageData {
  const rgb8 = unpremultiplyEncodeGamut(cap.linearPixels, cap.width, cap.height, {
    sourceGamut: WORKING_GAMUT,
    targetGamut: toDisplayTrackCanvasColorSpace(cap.gamut),
    bitDepth: 8,
  }) as Uint8ClampedArray;
  // Zero-copy re-view: the encoder's return type is `Uint8ClampedArray<ArrayBufferLike>`,
  // while `ImageData` demands an `ArrayBuffer`-backed one. The encoder allocates a
  // plain array (never a SharedArrayBuffer), so this narrows the type without
  // touching the bytes.
  const bytes = new Uint8ClampedArray(rgb8.buffer as ArrayBuffer, rgb8.byteOffset, rgb8.length);
  return new ImageData(bytes, cap.width, cap.height, {
    colorSpace: toDisplayTrackCanvasColorSpace(cap.gamut),
  });
}

// ─────────────────────── Alpha probe (hit-test pass-through) ───────────────────────

/**
 * Lazily created 1x1 readback scratch canvas. Drawing the 1x1 source rect of a
 * bitmap into it and reading it back with `getImageData` yields the alpha byte
 * under the point. A single module-level scratch avoids per-call canvas
 * construction, and `willReadFrequently` keeps it on the software backend,
 * dodging the GPU-canvas readback sync penalty on hover-frequency reads.
 * `null` means the environment has no OffscreenCanvas (Node tests / SSR).
 */
let alphaProbeCtx: OffscreenCanvasRenderingContext2D | null | undefined;

function getAlphaProbeContext(): OffscreenCanvasRenderingContext2D | null {
  if (alphaProbeCtx !== undefined) return alphaProbeCtx;
  if (typeof OffscreenCanvas === 'undefined') {
    alphaProbeCtx = null;
    return alphaProbeCtx;
  }
  const canvas = new OffscreenCanvas(1, 1);
  alphaProbeCtx = canvas.getContext('2d', { willReadFrequently: true });
  return alphaProbeCtx;
}

/**
 * alphaAtTexel: Read the alpha byte (0-255) of `bitmap` at point `p` in
 * BITMAP PIXEL coordinates, or `undefined` when the environment cannot
 * perform CPU canvas readbacks. This is the pure bitmap-domain probe — no
 * layer knowledge, no cache access: the caller decides WHICH bitmap to probe
 * and whether probing is meaningful.
 *
 * The name pins the discrete semantics: the point is resolved to a single
 * texel by exact source-rect sampling (`floor` to the pixel grid), never by
 * destination scaling — fractional coordinates quantize down. A point outside
 * the bitmap extent answers 0 (fully transparent) — the bitmap IS the content
 * extent. Module-private: the only consumer is `sampleAlphaOfLayer`.
 */
function alphaAtTexel(bitmap: ImageBitmap, p: Point2D): number | undefined {
  const px = Math.floor(p.x);
  const py = Math.floor(p.y);
  if (px < 0 || py < 0 || px >= bitmap.width || py >= bitmap.height) return 0;

  const ctx = getAlphaProbeContext();
  if (!ctx) return undefined;

  ctx.clearRect(0, 0, 1, 1);
  ctx.drawImage(bitmap, px, py, 1, 1, 0, 0, 1, 1);
  return ctx.getImageData(0, 0, 1, 1).data[3];
}

// ─────────────── Content-hit resolution (per-layer adjudication) ───────────────

/**
 * STROKE_HIT_EPS: hit tolerance in local px, added to the nominal radius.
 * Matches the inclusive on-edge semantics of the geometric hit branches: a
 * point exactly on the stroke boundary is a hit, and one pixel of slop
 * forgives sub-pixel rounding between the declared tip size and the rendered
 * coverage.
 */
const STROKE_HIT_EPS = 1;

/** Squared distance from `p` to the closed segment a→b. Degenerate → to a. */
function pointSegmentDistanceSq(p: Point2D, a: Point2D, b: Point2D): number {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const lenSq = ex * ex + ey * ey;
  if (lenSq < 1e-12) {
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    return dx * dx + dy * dy;
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / lenSq));
  const dx = p.x - (a.x + t * ex);
  const dy = p.y - (a.y + t * ey);
  return dx * dx + dy * dy;
}

/**
 * Flatten memo for pen paths: WeakMap keyed on the PenPathData reference.
 * Pen paths are committed payloads (immutable after submission), so reference
 * identity implies content identity — a pure memo, same argument as the
 * shape-rings cache in geometry. Flattening (adaptive sampling per cubic)
 * costs far more than the SVG parse, which makes the memo load-bearing.
 */
const penRingsCache = new WeakMap<PenPathData, Point2D[][]>();

/** Flatten a pen path to per-subpath point rings (memoized by reference). */
function penRings(path: PenPathData): Point2D[][] {
  const cached = penRingsCache.get(path);
  if (cached) return cached;
  const rings: Point2D[][] = [];
  // Flatten each subpath independently so the fill test can apply even-odd
  // across rings (subpath holes) exactly like the renderer's fill rule.
  // penPathToCubicSegments concatenates every subpath's segments in order
  // without tagging them; rebuild the boundaries from anchor counts
  // (open subpath: n-1 segments, closed: n; degenerate single-anchor
  // subpaths contribute none).
  const segments = penPathToCubicSegments(path);
  let cursor = 0;
  for (const sub of path.paths) {
    const a = sub.anchors;
    if (a.length < 2) continue;
    const count = sub.closed ? a.length : a.length - 1;
    const chain = segments.slice(cursor, cursor + count);
    cursor += count;
    const polyline = flattenCubicChain(chain, 0.5);
    // A closed subpath's flattened chain does not repeat the first point;
    // the ring test closes implicitly (isPointInPathRings wraps edges).
    if (polyline.length >= 2) rings.push(polyline);
  }
  penRingsCache.set(path, rings);
  return rings;
}

/**
 * isPointInStrokeLayer: Does the point lie on any stroke of a brush-collection
 * layer? Mirrors the engine's stroke extrude model (the sweep of discs of
 * radius `size × pressure / 2` riding the trajectory — see the vector
 * translator's width lane packing). Per stroke, three gates, all in the
 * stroke's box-local frame:
 *
 *   1. box fast screen — outside the snug box expanded by the maximum reach,
 *      the stroke cannot reach the point (most strokes exit here);
 *   2. confinement gate — a stroke drawn inside a selection only paints (and
 *     therefore only hits) inside that frozen snapshot; the rings travel with
 *     the stroke in box-local coordinates, so the containment test uses the
 *     same re-based point as the trajectory;
 *   3. trajectory distance — per-segment radius uses the interpolated
 *     pressure of the segment endpoints (the discs at both ends bound the
 *     swept band between them).
 *
 * Soft-edge semantics (decision D1 of the vector-content-hit spec): the hit
 * radius is the nominal tip radius. Softer brushes (hardness < 1) fade before
 * that radius, so their faint fringe stays clickable — deliberately generous.
 * Tightening to the 50%-coverage isoline needs this renderer's smoothstep
 * formula pinned first; deferred until on-device feedback.
 */
function isPointInStrokeLayer(strokes: readonly StrokeData[], p: Point2D): boolean {
  for (const stroke of strokes) {
    const box = stroke.box;
    // Re-base into the stroke's box-local frame (trajectory + confinement both
    // live there — the renderer re-bases both by the same box shift). Legacy
    // strokes without a box kept layer-local points; the persistence migration
    // gives every stroke a box, so absent box = origin 0.
    const lx = p.x - (box?.x ?? 0);
    const ly = p.y - (box?.y ?? 0);

    // Gate 1: snug-box fast screen. The box bounds the TRAJECTORY; the swept
    // discs plus the hit tolerance reach beyond it, so the screen expands by
    // maxReach = max tip radius + tolerance on every side.
    if (box) {
      let maxHalf = 0;
      for (const pt of stroke.points) {
        const half = (stroke.size * pt.pressure) / 2;
        if (half > maxHalf) maxHalf = half;
      }
      const reach = maxHalf + STROKE_HIT_EPS;
      if (lx < -reach || ly < -reach ||
          lx > box.w + reach || ly > box.h + reach) {
        continue;
      }
    }

    // Gate 2: frozen selection snapshot — outside it the stroke never paints.
    if (stroke.confinement) {
      if (!isPointInPathRings({ x: lx, y: ly }, stroke.confinement.rings)) {
        continue;
      }
    }

    // Gate 3: distance to the swept-disc trajectory.
    const pts = stroke.points;
    const n = pts.length;
    if (n === 0) continue;
    if (n === 1) {
      const half = (stroke.size * pts[0].pressure) / 2 + STROKE_HIT_EPS;
      const dx = lx - pts[0].x;
      const dy = ly - pts[0].y;
      if (dx * dx + dy * dy <= half * half) return true;
      continue;
    }
    for (let i = 0; i < n - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const half = (stroke.size * Math.max(a.pressure, b.pressure)) / 2 + STROKE_HIT_EPS;
      if (pointSegmentDistanceSq({ x: lx, y: ly }, a, b) <= half * half) {
        return true;
      }
    }
  }
  return false;
}

/**
 * isPointInPenLayer: Does the point lie on a pen layer's painted channels?
 * Mirrors the engine's vector-render semantics for pen sources:
 *   - fill channel → even-odd containment over the flattened rings;
 *   - stroke channel → capsule band riding the path (distance to the nearest
 *     flattened chain ≤ half the stroke width plus the hit tolerance).
 * Returns `undefined` when the layer paints nothing (both channels null) —
 * no content exists to adjudicate, the caller keeps the geometric hit.
 */
function isPointInPenLayer(
  penData: PenPathData,
  style: PenLayerStyle | undefined,
  p: Point2D,
): boolean | undefined {
  const hasFill = !!style?.fill;
  const strokeWidth = style?.stroke?.width ?? 0;
  const hasStroke = !!style?.stroke && strokeWidth > 0;
  if (!hasFill && !hasStroke) return undefined;

  const rings = penRings(penData);

  if (hasFill && isPointInPathRings(p, rings)) return true;

  if (hasStroke) {
    const half = strokeWidth / 2 + STROKE_HIT_EPS;
    for (const ring of rings) {
      const n = ring.length;
      if (n < 2) continue;
      for (let i = 0; i < n; i++) {
        if (pointSegmentDistanceSq(p, ring[i], ring[(i + 1) % n]) <= half * half) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Transparency threshold (0-255) for the bitmap alpha probe: samples below it
 * read as "no ink here". Baked into the engine probe — no caller has ever
 * needed a different value (add an option only when one shows up).
 */
const ALPHA_TRANSPARENCY_THRESHOLD = 10;

/**
 * hitVoidOfLayerAtPoint: the engine's void probe — the layer service's content
 * gate for layer picking. One probe, four adjudication
 * paths, each mirroring the implementation that renders it:
 *
 *   - image → bitmap alpha probe (alphaAtTexel over `imageBitmapCache`);
 *   - vector brush strokes → swept-disc trajectory test mirroring the
 *     extrude compute's coverage model;
 *   - vector pen paths → fill/capsule tests mirroring the vector renderer's
 *     channel semantics;
 *   - declarative SDF shapes (plugin-contributed vector sources — markers)
 *     → even-odd over the render source's own analytic `solverOutline`:
 *     hit and render read ONE produced artifact, so they cannot drift;
 *   - everything else (text / color / group) → `undefined`.
 *
 * Contract: returns `true` when the point is
 * over empty content (pointer pierces underneath), `false` when content is
 * confirmed, and `undefined` to degrade (keep the geometric hit) whenever a
 * faithful CPU answer is impossible — non-bitmap content, GPU-composited
 * bitmap masks, cold-cache bitmaps (hover must never trigger a decode),
 * non-browser environment, or a content family this probe does not own.
 */
/**
 * Declarative SDF coverage rings for a layer, derived from the layer's
 * TRANSLATED RENDER SOURCE (the same `LayerSource` the compositor consumes —
 * hit and render read one produced artifact, so they cannot drift). Plugin
 * vector-source contributions (markers are the founding case) already hand
 * the engine the analytic `solverOutline` plus `hasFill`; the hit-ring-set
 * semantics follow the paint mode: a filled shape's interior is all content
 * (outer ring only), a stroke-only shape's even-odd over outer+inner is
 * exactly the stroke band (hollow pierces). `null` = no declarative SDF
 * source, no analytic outline, or a degenerate ring — the caller keeps the
 * geometric hit.
 *
 * Cost guards: only `vector` layers can carry a declarative SDF source (text /
 * color / group never do — skipping them avoids wasted translator work such
 * as a text layout pass), and a WeakMap memo on the layer's object identity
 * keeps repeated picks over the same untouched layer free (layers are
 * immutable patches: any geometry change produces a new object and a fresh
 * translation — the same reference-identity memo pattern as `penRings`).
 */
const sdfCoverageRingsMemo = new WeakMap<Layer, Point2D[][] | null>();

function sdfCoverageRings(layer: Layer): Point2D[][] | null {
  if (layer.type !== 'vector') return null;
  if (sdfCoverageRingsMemo.has(layer)) return sdfCoverageRingsMemo.get(layer) ?? null;
  const source = layerToVectorSource(layer, WORKING_GAMUT, {
    width: layer.bounding.w,
    height: layer.bounding.h,
  });
  let rings: Point2D[][] | null = null;
  if (source && source.kind === 'vector' && source.renderer === 'sdf') {
    const outline = source.sdf.solverOutline;
    if (outline && outline.outer.length >= 6) {
      const toRing = (flat: readonly number[]): Point2D[] => {
        const ring: Point2D[] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) {
          ring.push({ x: flat[i], y: flat[i + 1] });
        }
        return ring;
      };
      const outer = toRing(outline.outer);
      if (outer.length >= 3) {
        if (source.sdf.hasFill) {
          rings = [outer];
        } else {
          const inner = toRing(outline.inner);
          rings = inner.length >= 3 ? [outer, inner] : [outer];
        }
      }
    }
  }
  sdfCoverageRingsMemo.set(layer, rings);
  return rings;
}

export function hitVoidOfLayerAtPoint(
  layer: Layer,
  p: Point2D,
): boolean | undefined {
  // The engine families below adjudicate the content they render. A final
  // declarative branch derives coverage from the layer's translated render
  // source (plugin-contributed SDF shapes — markers). `undefined` overall
  // keeps the geometric hit (degrade, never reject).

  // 1. Bitmap alpha (image layers): the CPU bitmap predates GPU-stage
  //    opacity/blend by design — a semi-transparent layer must stay clickable.
  if (layer.type === 'image') {
    if (layer.bitmapMasks && layer.bitmapMasks.length > 0) return undefined;
    const bitmap = imageBitmapCache.getOrFetch(layer.src);
    if (!bitmap) return undefined; // Cold asset — degrade, never fetch on hover.
    const alpha = alphaAtTexel(bitmap, p);
    if (alpha === undefined) return undefined;
    return alpha < ALPHA_TRANSPARENCY_THRESHOLD;
  }

  // 2. Brush-stroke collections (vector renderer: swept-disc extrude).
  if (layer.strokes || layer.strokeData) {
    const strokes = layer.strokes ?? (layer.strokeData ? [layer.strokeData] : []);
    return !isPointInStrokeLayer(strokes, p);
  }

  // 3. Pen paths (vector renderer: fill + stroke channels).
  if (layer.penData) {
    const hit = isPointInPenLayer(layer.penData, layer.penStyle, p);
    return hit === undefined ? undefined : !hit;
  }

  // 4. Declarative SDF coverage (plugin-contributed vector sources):
  //    even-odd over the render source's own analytic outline.
  const rings = sdfCoverageRings(layer);
  if (rings) return !isPointInPathRings(p, rings);

  return undefined;
}
