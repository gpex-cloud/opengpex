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
 * densityComposite.ts — Pure sizing for the density-banded interactive
 * composite (plan §3.3, P3).
 *
 * Split out of `WebGpuEngine`/`RenderGraph` so the band arithmetic — the part
 * that decides at which density the interactive composite renders and how the
 * VRAM hard cap degrades it — is a plain function testable without a GPU
 * device, and so the engine (which sizes its resident composite target) and
 * the graph (which sizes one-shot targets) cannot drift apart.
 *
 * ── MODEL ──
 *   • `screenScale` = physical screen px per document px = the camera's
 *     `effectiveScale(scene.view.transform)` (cam.k × dpr, pixel-snapped).
 *   • `band` = `quantizeDensityBand(screenScale)` — the SAME bands the glyph
 *     atlas uses, so the atlas and the composite always rasterize at a
 *     consistent density and pan/zoom inside a band is quantized away (zero
 *     re-composite; crossing a band costs exactly one).
 *   • The achieved scale is the band clamped UNIFORMLY by the VRAM hard cap:
 *     `min(band, ceil / max(docW, docH))`, `ceil = min(maxTextureDimension2D,
 *     4096)`. The clamp factor is shared by BOTH axes (driven by the LONGER
 *     edge) so the composite always preserves the document aspect ratio — the
 *     present channel (`ViewPass` / `densityScale`) consumes a single scalar
 *     and cannot express per-axis densities. 4K/8K canvases at high zoom land
 *     here, degrading toward document-resolution compositing instead of
 *     allocating an over-limit / 400 MB+ texture.
 *
 * @module core/engine/pipeline/graph/support/densityComposite
 */

import { quantizeDensityBand } from '@opengpex/editor/core/engine/text/glyphAtlas';

/**
 * Absolute composite-texture edge ceiling (px) — plan §3.3 review fix. Bounds
 * the rgba16float composite target regardless of what `maxTextureDimension2D`
 * permits (4096² rgba16float ≈ 128 MiB; a second ping-pong buffer doubles it).
 */
export const INTERACTIVE_COMPOSITE_CEIL_PX = 4096;

/** Quantized interactive composite density (uniform scalar, shared by both axes). */
export interface InteractiveDensity {
  /**
   * The quantized density band (glyph-atlas bands). Constant inside a
   * pan/zoom gesture segment — the ONLY camera-derived dimension the content
   * cache may key on.
   */
  readonly band: number;
  /**
   * Achieved composite scale on X (≤ band; < 1 only when hard-cap clamped).
   * ALWAYS equal to `scaleY` — the hard cap clamps via the longer edge so the
   * composite keeps the document aspect ratio.
   */
  readonly scaleX: number;
  /** Achieved composite scale on Y (=== `scaleX`, see above). */
  readonly scaleY: number;
}

/**
 * Resolve the interactive composite density for the current camera frame.
 *
 * `screenScale ≤ 1` (fit / zoomed out / 100% on dpr 1) resolves to band 1 with
 * identity scale — byte-identical to the pre-P3 document-resolution composite.
 */
export function resolveInteractiveDensity(
  screenScale: number,
  docWidth: number,
  docHeight: number,
  maxTextureDimension2D: number,
): InteractiveDensity {
  const band = quantizeDensityBand(screenScale);
  const ceil = Math.max(1, Math.min(maxTextureDimension2D, INTERACTIVE_COMPOSITE_CEIL_PX));
  const w = Math.max(1, docWidth);
  const h = Math.max(1, docHeight);
  // Aspect-preserving clamp: BOTH axes share one factor driven by the longer
  // edge. Per-edge clamping here produced non-uniform densities that the
  // present channel flattened into a single `densityScale` scalar (visible as
  // a ~1.33x horizontal stretch on a 3:4 canvas once band > ceil/shortEdge).
  const scale = Math.min(band, ceil / Math.max(w, h));
  return { band, scaleX: scale, scaleY: scale };
}

/**
 * Composite-target content dimensions at an interactive density: the document
 * extent scaled per axis, ≥ 1 and integer. `scale = [1, 1]` reproduces the
 * document-resolution composite exactly. Both the engine's resident target
 * and `RenderGraph.composite` size through THIS function so their dims can
 * never disagree (the engine-owned `ctx.target` must match the graph's
 * `frameWidth/Height` exactly).
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
