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
 * densityComposite.ts — Sizing for the fixed-density interactive composite.
 *
 * The interactive composite is baked ONCE per document resolution at a FIXED
 * density and every camera frame replays it (the Photoshop model: zooming in
 * reveals the document's own pixels, never a sharper re-rasterization). This
 * module owns the two pure pieces of that contract:
 *
 *   • `resolveCompositeDensity` — the dpr → density fold behind the
 *     "adaptive rendering" preference: ON bakes at `ceil(dpr)` texels per
 *     document pixel (integer, so texel boundaries coincide with document
 *     pixel boundaries and the pixel-grid overlay aligns at every zoom);
 *     OFF bakes at exactly 1 (strict WYSIWYG).
 *   • `densityCompositeDims` — composite-target pixel dimensions at a given
 *     per-axis scale. Both the engine's resident target and
 *     `RenderGraph.composite` size through THIS function so their dims can
 *     never disagree (the engine-owned `ctx.target` must match the graph's
 *     `frameWidth/Height` exactly).
 *
 * The zoom-derived density-band quantization this module once performed is
 * GONE by design: a density that moved with the camera is what produced the
 * 1/16 edge quantization, the per-band re-composite stalls, and the
 * document × band² memory multiplication. Do not reintroduce a camera term
 * here — sharpness-tracking-zoom is a pure-vector-tool goal (Figma), not a
 * raster editor's.
 *
 * @module core/engine/pipeline/graph/support/densityComposite
 */

/**
 * Per-axis composite scale. Both axes always carry the SAME value: the
 * present channel (`ViewPass` / `densityScale`) consumes a single scalar and
 * cannot express per-axis densities, and an aspect-distorting density would
 * stretch the composite against the pixel grid.
 */
export interface InteractiveDensity {
  /** Achieved composite scale on X (texels per document pixel). */
  readonly scaleX: number;
  /** Achieved composite scale on Y (=== `scaleX`). */
  readonly scaleY: number;
}

/**
 * Fold the "adaptive rendering" preference and the display's device pixel
 * ratio into the fixed composite density.
 *
 * - `adaptive` false → 1: strict 1 document pixel : 1 CSS pixel composite.
 * - `adaptive` true → `ceil(dpr)` (≥ 1): retina displays get texels to spare
 *   at 100%; the CEIL (not round) matters on fractional-dpr displays
 *   (Windows 1.25 / 1.5): the composite must never be coarser than the
 *   screen, otherwise 100% presents a MAGNIFIED nearest-neighbour sampling
 *   whose texel widths alternate n/n+1 device pixels — the exact phase
 *   defect the integer density exists to prevent.
 *
 * The result is consumed per frame but changes only when the display or the
 * preference changes; both flow into the composite target dims, so either
 * change costs exactly one re-composite through the engine's dimsChanged
 * rebuild path.
 */
export function resolveCompositeDensity(dpr: number, adaptive: boolean): number {
  if (!adaptive) return 1;
  return Math.max(1, Math.ceil(Math.max(0, dpr) || 1));
}

/** Wrap a scalar density as the per-axis scale (X === Y, see above). */
export function uniformDensity(scale: number): InteractiveDensity {
  const s = Math.max(1, scale);
  return { scaleX: s, scaleY: s };
}

/**
 * Composite-target content dimensions at an interactive density: the document
 * extent scaled per axis, ≥ 1 and integer. `scale = [1, 1]` reproduces the
 * document-resolution composite exactly.
 */
export function densityCompositeDims(
  docWidth: number,
  docHeight: number,
  scale: readonly [number, number],
): readonly [number, number] {
  const w = Math.max(1, Math.round(Math.max(1, docWidth) * Math.max(scale[0], 0)));
  const h = Math.max(1, Math.round(Math.max(1, docHeight) * Math.max(scale[1], 0)));
  return [w, h];
}
