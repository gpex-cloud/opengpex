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
 * RasterizeDispatcher — dispatches RASTERIZE jobs to Worker (Phase 6).
 *
 * Responsibilities:
 * 1. Text layer rasterization (text → bitmap via Worker or main-thread fallback)
 *
 * RasterizeDispatcher's boundary:
 *   - Only handles "pure rendering" without effect stacking
 *   - Text/color/vector → bitmap (no masks, no adjustments, no blend)
 *
 * For "layer flattening" (with masks/adjustments/blend), use CompositeDispatcher.
 *
 * Architecture: facade → RasterizeDispatcher → WorkerBridge → Worker (RasterizeHandler)
 */

import { WorkerBridge } from './bridge/WorkerBridge';
import { RasterizeResult } from '../results/RasterizeResult';
import { drawLayerInstance } from '../rendering/shared/painter2d';
import { canvasToBlob, calculateHash, buildTileMeta } from '../utils/pixel-utils';
import type { PixelResultData } from '../protocol/results';
import type { AssetService, Layer } from '@opengpex/editor/core/types';

export class RasterizeDispatcher {
  constructor(
    private bridge: WorkerBridge,
    private assets: AssetService,
  ) {}

  /**
   * Rasterize a layer to bitmap (text/color/vector → pixels).
   *
   * Text layers are rasterized on the main thread (reliable FontFace access).
   * Color/vector layers use the same main-thread approach for simplicity.
   *
   * @param layer - The layer to rasterize
   * @param opts  - Optional DPR for retina resolution
   * @returns RasterizeResult with the rasterized bitmap blob
   */
  async layer(layer: Layer, opts?: { dpr?: number }): Promise<RasterizeResult> {
    const dpr = opts?.dpr ?? ((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1);
    const w = layer.bounding.w || 1;
    const h = layer.bounding.h || 1;
    const canvas = new OffscreenCanvas(Math.ceil(w * dpr), Math.ceil(h * dpr));
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    // Use shared painter to render the layer content (text/color/vector)
    drawLayerInstance(ctx, layer, null);

    const blob = await canvasToBlob(canvas);
    const hash = await calculateHash(blob);
    const tileMeta = buildTileMeta(Math.ceil(w * dpr), Math.ceil(h * dpr), dpr);

    const data: PixelResultData = {
      blob,
      hash,
      tileMeta,
      depth: 8,
      bounds: { x: 0, y: 0, w: Math.ceil(w * dpr), h: Math.ceil(h * dpr) },
    };

    return new RasterizeResult(data, this.assets);
  }
}
