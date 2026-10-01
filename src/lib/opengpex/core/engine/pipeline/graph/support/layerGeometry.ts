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
 * layerGeometry.ts — Shared per-layer quad geometry resolution (WP-5.3).
 *
 * CompositePass and BlendPass previously duplicated the same ~22 lines deriving
 * a layer's content size, local offset and texture UV sub-rect from its `crop`
 * / `width` / `height` and the resident texture dimensions. Extracted here as a
 * single pure function so both passes stay in lock-step.
 *
 * @module core/gpu/graph/support/layerGeometry
 */

import type { LayerNode, Mat3 } from '../../scene/Scene';

export interface LayerGeometry {
  /** Quad width in content (source) pixels. */
  readonly contentWidth: number;
  /** Quad height in content (source) pixels. */
  readonly contentHeight: number;
  /** Local-space translation of the quad (crop origin), in content pixels. */
  readonly localOffset: [number, number];
  /** Texture sub-region to sample: (u0, v0, du, dv), normalized. */
  readonly uvRect: [number, number, number, number];
}

/**
 * Resolve the quad geometry + UV sub-rect for a layer against its resident
 * texture size. Behavior mirrors the original inline logic exactly:
 *   • `crop` wins → content = crop.w/h, offset = crop.x/y, uv = crop / texSize
 *   • else `width`/`height` (>0) → content = those, no crop, full uv
 *   • else → fall back to full texture size, full uv
 *
 * DPR NOTE: `crop` / `width` / `height` are LOGICAL (document)
 * pixels, whereas a DPR-aware texture is `logical × dprScale` PHYSICAL pixels
 * (e.g. a committed Text layer rasterized at `bounding × devicePixelRatio`). The
 * quad size (`contentWidth/Height`) and `localOffset` stay in logical pixels —
 * they are correct as-is — but the texture UV must be taken in the texture's own
 * (physical) space, so the crop is scaled by `dprScale` before dividing by the
 * texture size: `uv = crop × dprScale / texSize`. For bitmap / fragment layers
 * `dprScale === 1`, so the UV is byte-for-byte identical to before (zero
 * regression — the crop there is already in source pixels).
 */
export function resolveLayerGeometry(
  layer: LayerNode,
  textureWidth: number,
  textureHeight: number,
  dprScale = 1,
): LayerGeometry {
  const contentWidth = layer.crop
    ? layer.crop.w
    : typeof layer.width === 'number' && layer.width > 0
      ? layer.width
      : textureWidth;
  const contentHeight = layer.crop
    ? layer.crop.h
    : typeof layer.height === 'number' && layer.height > 0
      ? layer.height
      : textureHeight;

  const localOffset: [number, number] = [layer.crop?.x ?? 0, layer.crop?.y ?? 0];

  let uvRect: [number, number, number, number] = [0, 0, 1, 1];
  if (layer.crop) {
    const texW = Math.max(1, textureWidth);
    const texH = Math.max(1, textureHeight);
    // Scale the logical crop into physical texture space (see DPR NOTE above).
    const d = dprScale > 0 ? dprScale : 1;
    uvRect = [
      (layer.crop.x * d) / texW,
      (layer.crop.y * d) / texH,
      (layer.crop.w * d) / texW,
      (layer.crop.h * d) / texH,
    ];
  }

  return { contentWidth, contentHeight, localOffset, uvRect };
}

/**
 * Effective on-screen scale of a layer's sampled texture.
 *
 * `layer.transform` maps local content pixels → screen pixels (the camera zoom
 * is baked in by SceneAssembler). The per-axis scale magnitudes are the column
 * norms of the 2×2 linear part; we take the MIN axis so that "is any axis being
 * magnified" decides the sampler (matches GIMP's whole-image FILTER_AUTO). A
 * value ≥ 1 means one source texel covers ≥ 1 screen pixel → magnify → nearest;
 * < 1 means minify → linear. Rotation-invariant (uses column norms, not raw a/d).
 */
export function effectiveScale(transform: Mat3): number {
  const sx = Math.hypot(transform.a, transform.b);
  const sy = Math.hypot(transform.c, transform.d);
  return Math.min(sx, sy);
}

