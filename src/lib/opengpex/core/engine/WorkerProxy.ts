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

import { workerBridge } from './worker/WorkerBridge';
import {
  Dimensions, LocalRect, ShapeType, LocalShape,
  VectorMask, LayerItemForWorker, WorkerResult
} from '@opengpex/editor/core/types';

/**
 * WorkerProxy: Image processing service proxy
 * Core responsibilities: Acts as main thread proxy, scheduling Worker for heavy pixel calculations.
 */
export class WorkerProxy {
  /**
   * Flatten merge: synthesizes multiple layers into a new image
   */
  async mergeLayersToLayer(
    canvasDim: Dimensions,
    items: LayerItemForWorker[],
    options?: { targetDpr?: number }
  ): Promise<WorkerResult> {
    return workerBridge.request<WorkerResult>('MERGE_LAYERS_TO_LAYER', {
      canvas: canvasDim,
      layers: items,
      options
    });
  }

  /**
   * Shape clip: clips multiple layers to specified shape and synthesizes new image
   */
  async mergeLayersWithShape(
    canvasDim: Dimensions,
    shape: LocalShape,
    items: LayerItemForWorker[],
    options?: { format?: string; quality?: number }
  ): Promise<WorkerResult> {
    return workerBridge.request<WorkerResult>('MERGE_LAYERS_WITH_SHAPE', {
      canvas: canvasDim,
      shape,
      layers: items,
      options
    });
  }

  /**
   * Clone clip: clips region from specified asset
   */
  async cloneRegion(
    assetId: string,
    rect: LocalRect,
    shape?: ShapeType
  ): Promise<WorkerResult> {
    return workerBridge.request<WorkerResult>('CLONE_ASSET_REGION', {
      hash: assetId,
      rect,
      shape
    });
  }

  /**
   * Bake mask: applies logical mask to physical pixels
   */
  async bakeMasks(
    assetId: string,
    masks: VectorMask[]
  ): Promise<WorkerResult> {
    return workerBridge.request<WorkerResult>('BAKE_ASSET_MASKS', {
      hash: assetId,
      masks
    });
  }

  /**
   * Resamples image
   */
  async resampleImage(src: string, targetSize: { w: number; h: number }, options?: { format?: string; quality?: number }): Promise<WorkerResult> {
    return workerBridge.request<WorkerResult>('RESAMPLE_IMAGE', {
      src,
      targetSize,
      options
    });
  }

  /**
   * Ensures asset blob is decoded in Worker cache
   * Used to preload assets like bitmapMask during merging (which are normally only rendered on the main thread)
   */
  async ensureAssetInWorker(hash: string, blob: Blob): Promise<void> {
    await workerBridge.request('DECODE_AND_TILE', { hash, blob });
  }

  /**
   * Transcodes SVG to PNG raster via resvg-wasm in Worker.
   * Supports explicit width/height or falls back to maxDimension.
   */
  async transcodeSvg(blob: Blob, params?: { width?: number; height?: number; maxDimension?: number }): Promise<Blob> {
    const result = await workerBridge.request<{ blob: Blob }>('TRANSCODE_SVG', {
      blob,
      width: params?.width,
      height: params?.height,
      maxDimension: params?.maxDimension,
    });
    return result.blob;
  }

  /**
   * Transcodes EPS to PNG raster via Ghostscript WASM in Worker.
   * Requires explicit width, height, and dpi.
   */
  async transcodeEps(blob: Blob, params: { width: number; height: number; dpi: number }): Promise<Blob> {
    const result = await workerBridge.request<{ blob: Blob }>('TRANSCODE_EPS', {
      blob,
      width: params.width,
      height: params.height,
      dpi: params.dpi,
    });
    return result.blob;
  }

}


/**
 * Factory function: creates WorkerProxy instance
 */
export const createWorkerProxy = () => new WorkerProxy();
