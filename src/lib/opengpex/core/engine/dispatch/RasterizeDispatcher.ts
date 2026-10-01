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
 * RasterizeDispatcher — MAIN-THREAD layer rasterization (text/color/vector → bitmap).
 *
 * Responsibilities:
 * 1. Text layer rasterization (text → bitmap on the main thread)
 *
 * RasterizeDispatcher's boundary:
 *   - Only handles "pure rendering" without effect stacking
 *   - Text/color/vector → bitmap (no masks, no adjustments, no blend)
 *
 * For "layer flattening" (with masks/adjustments/blend), use CompositeDispatcher.
 *
 * ⚠️ NOT a Worker dispatcher (despite the name). `layer()` runs entirely on the
 * main thread (OffscreenCanvas + `drawLayerInstance`) because reliable `FontFace`
 * access only exists on the main thread. The former Worker-side `RasterizeHandler`
 * (RASTERIZE job) was retired as dead code on 20260912 — it never received a job.
 * The `bridge` ctor arg is retained only for construction symmetry with the other
 * dispatchers (PixelFacade passes it uniformly); this class does not use it.
 *
 * Architecture: facade → RasterizeDispatcher.layer() → OffscreenCanvas (main thread)
 */

import { WorkerBridge } from './bridge/WorkerBridge';
import type { RasterizedImage } from '../types';
import { drawLayerInstance } from '@opengpex/editor/core/engine/raster/rasterizer';
import { buildTextHighDepth } from '@opengpex/editor/core/engine/raster/paintText';
import { canvasToBlob, calculateHash } from '../utils/pixel-utils';
import type { AssetService, Layer } from '@opengpex/editor/core/types';

export class RasterizeDispatcher {
  constructor(
    private bridge: WorkerBridge,
    private assets?: AssetService,
  ) {}

  /**
   * Rasterize a layer to bitmap (text/color/vector → pixels).
   *
   * Text layers are rasterized on the main thread (reliable FontFace access).
   * Color/vector layers use the same main-thread approach for simplicity.
   *
   * @param layer - The layer to rasterize
   * @param opts  - Optional DPR for retina resolution
   * @returns RasterizedImage with the rasterized bitmap blob
   */
  async layer(layer: Layer, opts?: { dpr?: number }): Promise<RasterizedImage> {
    const dpr = opts?.dpr ?? ((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1);
    const w = layer.bounding.w || 1;
    const h = layer.bounding.h || 1;
    const canvas = new OffscreenCanvas(Math.ceil(w * dpr), Math.ceil(h * dpr));
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    // Use shared painter to render the layer content (text/color/vector)
    drawLayerInstance(ctx, layer);

    const blob = await canvasToBlob(canvas);
    const hash = await calculateHash(blob);

    const pxW = Math.ceil(w * dpr);
    const pxH = Math.ceil(h * dpr);

    const highDepth =
      layer.type === 'text' && layer.textData
        ? buildTextHighDepth(layer, pxW, pxH, dpr)
        : undefined;

    return {
      displayBlob: blob,
      width: pxW,
      height: pxH,
      dprScale: dpr,
      colorIdentity: highDepth
        ? { gamut: highDepth.space, trc: 'srgb-trc', bitDepth: 16, dataFormat: 'rgba16float' }
        : { gamut: 'srgb', trc: 'srgb-trc', bitDepth: 8 },
      highDepthSource: highDepth ? { data: highDepth.data, width: pxW, height: pxH } : undefined,
      bounds: { x: 0, y: 0, w: pxW, h: pxH },
      precomputedHash: hash,
    };
  }
}
