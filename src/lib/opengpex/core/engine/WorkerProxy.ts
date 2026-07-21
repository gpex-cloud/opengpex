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
   * Ensures asset blob is decoded in Worker cache and returns a WorkerResult (blob + hash + tileMeta).
   *
   * When `hash` is provided (e.g. layer.assetId is already known), it is used directly as the Worker
   * cache key — no extra hash computation needed.
   * When `hash` is omitted (e.g. Lane A/B vips output has no pre-existing hash), the Worker computes
   * it via HASH_ASSET before decoding, and the resolved hash is returned in the WorkerResult.
   *
   * Callers that only need the side-effect (cache warm-up) can ignore the return value.
   * Callers that need hash + tileMeta (e.g. shapeToAsset) can use the WorkerResult directly
   * to call assets.inject without a redundant decode.
   */
  async ensureAssetInWorker(blob: Blob, options?: { hash?: string }): Promise<import('@opengpex/editor/core/types').WorkerResult> {
    const resolvedHash = options?.hash ?? await workerBridge.request<string>('HASH_ASSET', blob);
    const tileMeta = await workerBridge.request<import('@opengpex/editor/core/types').TileMetadata>(
      'DECODE_AND_TILE', { hash: resolvedHash, blob }
    );
    return { blob, hash: resolvedHash, tileMeta };
  }

  /**
   * Computes hash + TileMetadata for a one-shot blob WITHOUT storing anything in Worker LRU.
   *
   * Use this for Lane A/B vips export output where the resulting blob will be returned to
   * the caller directly and never rendered again. Avoids polluting the Worker LRU with
   * large export bitmaps that have no render-path reuse.
   *
   * Contrast with `ensureAssetInWorker` which always stores the decoded bitmap in LRU
   * (intended for render-path assets that will be composited repeatedly).
   */
  async computeBlobMetadata(blob: Blob): Promise<import('@opengpex/editor/core/types').WorkerResult> {
    const { hash, tileMeta } = await workerBridge.request<{ hash: string; tileMeta: import('@opengpex/editor/core/types').TileMetadata }>(
      'COMPUTE_BLOB_METADATA', { blob }
    );
    return { blob, hash, tileMeta };
  }

  /**
   * Transcodes TIFF to PNG raster via wasm-vips in Worker.
   * Handles all TIFF variants: LZW/ZIP/JPEG compression, 16-bit, CMYK, BigTIFF.
   */
  async transcodeTiff(blob: Blob): Promise<Blob> {
    const result = await workerBridge.request<{ blob: Blob }>('TRANSCODE_TIFF', {
      blob,
    });
    return result.blob;
  }

  /**
   * Encodes RGBA ImageData to TIFF blob via wasm-vips in Worker.
   * Supports none/lzw/zip compression and DPI metadata injection.
   */
  async encodeTiff(imageData: ImageData, options: { compression: string; dpi: number }): Promise<Blob> {
    const result = await workerBridge.request<{ blob: Blob }>('ENCODE_TIFF', {
      data: imageData.data,
      width: imageData.width,
      height: imageData.height,
      compression: options.compression,
      dpi: options.dpi,
    });
    return result.blob;
  }

}


/**
 * Factory function: creates WorkerProxy instance
 */
export const createWorkerProxy = () => new WorkerProxy();
