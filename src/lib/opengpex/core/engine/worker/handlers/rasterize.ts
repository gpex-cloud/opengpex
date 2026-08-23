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
 * RasterizeHandler — Worker-side handler for rasterization jobs.
 *
 * Extracted from v1 `worker/handlers/transformer.ts` (rasterize portion).
 *
 * Supports two sub-types:
 * - 'text': Rasterize text content to a bitmap (Worker-side fallback)
 * - 'mask': Bake vector masks into the source bitmap, producing a flattened result
 *
 * Note: Primary text rasterization happens on the main thread via
 * CompositeDispatcher.preRasterizeText (which has access to FontFace API).
 * This handler serves as a secondary path for non-font operations.
 */

import type { RasterizeJob } from '../../protocol/jobs';
import type { PixelResultData } from '../../protocol/results';
import type { VectorMask, ClipDescriptor } from '@opengpex/editor/core/types';
import { drawLayerInstance } from '../../rendering/shared/painter2d';
import { workerCache } from '../cache/WorkerCache';
import { canvasToBlob, calculateHash, buildTileMeta } from '../../utils/pixel-utils';
import { shapeToPath2D } from '@opengpex/editor/core/helpers/path2d';
import { shrinkInvertedMask } from '@opengpex/editor/core/helpers/sub-pixel';

/** Payload shape for 'mask' sub-type */
interface RasterizeMaskPayload {
  hash: string;
  masks: VectorMask[];
}

/** Payload shape for 'text' sub-type */
interface RasterizeTextPayload {
  width: number;
  height: number;
  textData: {
    content?: string;
    color?: string;
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: number;
    italic?: boolean;
    lineHeight?: number;
    align?: CanvasTextAlign;
    boxMode?: 'auto' | 'fixed';
    boxWidth?: number;
    underline?: boolean;
    strikethrough?: boolean;
  };
}

export class RasterizeHandler {
  /**
   * Handle a RasterizeJob — dispatch to the appropriate sub-handler.
   */
  async handle(job: RasterizeJob): Promise<{ result: PixelResultData; transfer?: Transferable[] }> {
    switch (job.subType) {
      case 'text':
        return this.rasterizeText(job.payload as RasterizeTextPayload);
      case 'mask':
        return this.rasterizeMask(job.payload as RasterizeMaskPayload);
      default:
        throw new Error(`[RasterizeHandler] Unknown subType: ${job.subType}`);
    }
  }

  /**
   * Rasterize text to a bitmap.
   *
   * Note: This is a fallback path. Primary text rasterization occurs on the
   * main thread (CompositeDispatcher.preRasterizeText) where FontFace API
   * works correctly. This handler is available for non-interactive scenarios.
   */
  private async rasterizeText(
    payload: RasterizeTextPayload,
  ): Promise<{ result: PixelResultData; transfer?: Transferable[] }> {
    const { width, height, textData } = payload;
    const w = width || 1;
    const h = height || 1;

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;

    // Build a minimal LayerLike for painter
    const layerLike = {
      type: 'text' as const,
      bounding: { w, h },
      opacity: 1,
      textData,
    };

    drawLayerInstance(ctx, layerLike, null);

    const blob = await canvasToBlob(canvas);
    const hash = await calculateHash(blob);
    const tileMeta = buildTileMeta(w, h, 1);

    return {
      result: {
        blob,
        hash,
        tileMeta,
        depth: 8,
        bounds: { x: 0, y: 0, w, h },
      },
    };
  }

  /**
   * Bake vector masks into a source bitmap.
   *
   * Adapted from v1 `transformer.ts/bakeAssetMasks`.
   * Retrieves the source bitmap from WorkerCache, applies the mask clip sequence,
   * and produces a new bitmap with the masks permanently applied.
   */
  private async rasterizeMask(
    payload: RasterizeMaskPayload,
  ): Promise<{ result: PixelResultData; transfer?: Transferable[] }> {
    const { hash, masks } = payload;

    const source = workerCache.getBitmap(hash);
    if (!source) {
      throw new Error(
        `[RasterizeHandler] Asset not in WorkerCache: hash=${hash}. ` +
        'Ensure ensureAsset was called before rasterize.',
      );
    }

    const { width, height } = source;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;

    // Build minimal layer for painter
    const layerLike = {
      type: 'image' as const,
      bounding: { w: width, h: height },
      opacity: 1,
    };

    // Build clip sequence from vector masks
    const clipSequence: ClipDescriptor[] = masks.map(m => ({
      shape: m.shape,
      inverted: m.inverted,
      feather: m.feather || 0,
      __compiledPath2D: shapeToPath2D(shrinkInvertedMask(m.shape, m.inverted, 1, layerLike.bounding)),
    })) as ClipDescriptor[];

    drawLayerInstance(ctx, layerLike, source, { clipSequence });

    const blob = await canvasToBlob(canvas);
    const resultHash = await calculateHash(blob);
    const tileMeta = buildTileMeta(width, height, 1);

    return {
      result: {
        blob,
        hash: resultHash,
        tileMeta,
        depth: 8,
        bounds: { x: 0, y: 0, w: width, h: height },
      },
    };
  }
}
