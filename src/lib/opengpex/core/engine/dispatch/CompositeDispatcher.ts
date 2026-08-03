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
 * CompositeDispatcher — orchestrates composite requests from main thread.
 *
 * Responsibilities:
 * 1. Accept high-level composite requests (layers + frame + roi + precision)
 * 2. Construct LayerDescriptor[] (compute world matrices, extract hashes)
 * 3. Ensure Worker cache is ready (ensureAssetsReady)
 * 4. Send CompositeJob to Worker via WorkerBridge
 * 5. Wrap result as CompositeResult
 *
 * Text layer strategy: Worker FontFace behavior is unreliable for custom fonts,
 * so text layers are pre-rasterized on the main thread into bitmaps, then
 * passed to the Worker as ordinary 'image' descriptors.
 *
 * Architecture: facade → CompositeDispatcher → WorkerBridge → Worker (CompositorHandler)
 */

import { WorkerBridge } from './bridge/WorkerBridge';
import type { LayerDescriptor } from '../protocol/descriptors';
import { asWorldMatrix } from '../protocol/descriptors';
import type { CompositeJob } from '../protocol/jobs';
import type { PixelResultData } from '../protocol/results';
import { CompositeResult } from '../results/CompositeResult';
import { drawLayerInstance } from '../rendering/shared/painter2d';
import { canvasToBlob, calculateHash, buildTileMeta } from '../utils/pixel-utils';
import { getCompositeStrategy } from '@opengpex/editor/core/color/ColorPipeline';
import type {
  Layer,
  TRC,
  WorkingColorSpace,
  WorldShape,
  AssetService,
  GeometryService,
} from '@opengpex/editor/core/types';

// ─── Request interface ───

export interface CompositeRequest {
  layers: Layer[];
  /** ROI must be in world-space (branded WorldShape). Use geometry.shape.localToWorldShape() to convert. */
  roi: WorldShape;
  precision?: 8 | 16 | 32;
  dpr?: number;
  /** When specified, overrides dpr-based output sizing. Worker outputs exactly this size. */
  outputSize?: { w: number; h: number };

  /**
   * Target TRC for compositing (Phase B — linear-light compositing).
   * Derived from `Frame.trc` by higher-level APIs.
   * When not specified, defaults to `'srgb-trc'`.
   *
   * ⚠️ Performance-critical mode switch:
   *   - 'srgb-trc': Hardware-accelerated Canvas 2D compositing (~1ms/frame)
   *   - 'linear':   Manual per-pixel blending via ImageData (~50-200ms/frame for 4K)
   * The linear path is intended for offscreen export only, NOT onscreen preview.
   */
  compositeTRC?: TRC;

  /**
   * Color space for compositing (Phase C — wide gamut).
   * Accepts Frame.colorSpace directly; the Dispatcher normalizes to
   * Canvas 2D-supported values ('srgb' | 'display-p3') internally.
   */
  compositeColorSpace?: string;
}

// ─── CompositeDispatcher ───

export class CompositeDispatcher {
  constructor(
    private bridge: WorkerBridge,
    private geometry: GeometryService,
    private assets: AssetService,
  ) {}

  /**
   * Low-level API: directly pass a CompositeRequest.
   *
   * 1. Builds descriptors (including text pre-rasterize)
   * 2. Ensures Worker cache has all required blobs
   * 3. Posts CompositeJob to Worker
   * 4. Returns CompositeResult
   */
  async composite(request: CompositeRequest): Promise<CompositeResult> {
    // 1. Build descriptors (may pre-rasterize text layers)
    const descriptors = await this.buildDescriptors(request.layers);

    // 2. Ensure Worker cache contains all needed blobs
    await this.ensureAssetsReady(descriptors);

    // 3. Construct and send CompositeJob
    const dpr = request.dpr ?? 1;
    const job: CompositeJob = {
      type: 'COMPOSITE',
      layers: descriptors,
      roi: request.roi,
      precision: request.precision ?? 8,
      dpr,
      // outputSize takes priority; otherwise fall back to roi * dpr (backward-compatible)
      outputWidth: request.outputSize?.w ?? Math.ceil(request.roi.rect.w * dpr),
      outputHeight: request.outputSize?.h ?? Math.ceil(request.roi.rect.h * dpr),
      // Phase B: Pass compositeTRC to Worker for linear-light blending
      compositeTRC: request.compositeTRC,
      // Phase C: Normalize to Canvas 2D-supported colorSpace via strategy matrix
      compositeColorSpace: getCompositeStrategy((request.compositeColorSpace ?? 'srgb') as WorkingColorSpace).canvasColorSpace,
    };

    const data = await this.bridge.request<PixelResultData>(job);
    return new CompositeResult(data, this.assets);
  }

  // ────────────────────────────────────────────────────────────
  // Private helpers
  // ────────────────────────────────────────────────────────────

  /**
   * Build LayerDescriptor[] from Layer[].
   *
   * Text layers are pre-rasterized on the main thread (we have full FontFace
   * access here), then registered as temporary assets and converted to 'image'
   * type descriptors. The Worker receives them as normal images.
   */
  private async buildDescriptors(layers: Layer[]): Promise<LayerDescriptor[]> {
    const descriptors: LayerDescriptor[] = [];

    for (const layer of layers) {
      if (layer.type === 'text') {
        const rasterized = await this.preRasterizeText(layer);
        descriptors.push(rasterized);
      } else {
        const descriptor = await this.buildDescriptor(layer);
        descriptors.push(descriptor);
      }
    }

    return descriptors;
  }

  /**
   * Text layer pre-rasterize:
   * Main thread has complete font environment → rasterize to bitmap →
   * register as temporary asset → return image-type descriptor.
   * Worker receives a plain image, no font handling needed.
   */
  private async preRasterizeText(layer: Layer): Promise<LayerDescriptor> {
    const w = layer.bounding.w || 1;
    const h = layer.bounding.h || 1;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;

    // Use shared painter to draw text content
    drawLayerInstance(ctx, layer, null);

    const blob = await canvasToBlob(canvas);
    const hash = await calculateHash(blob);
    const tileMeta = buildTileMeta(w, h, 1);

    // Register as temporary asset (cache warming via AssetService hooks)
    const id = await this.assets.inject(hash, blob, tileMeta);

    const raw = this.geometry.transform.getLayerWorldMatrix(layer);
    const worldMatrix = asWorldMatrix(raw);

    return {
      type: 'image', // ← Downgraded to image type
      assetId: id,
      hash, // ← Worker uses hash to look up WorkerCache
      metadata: layer.metadata,
      textData: undefined,
      bounding: layer.bounding,
      visibleShape: layer.visibleShape,
      vectorMasks: layer.vectorMasks,
      bitmapMasks: layer.bitmapMasks,
      opacity: layer.opacity,
      blendMode: layer.blendMode ?? 'source-over',
      fill: layer.fill,
      adjustments: layer.adjustments,
      curves: layer.curves,
      levels: layer.levels,
      channelMix: layer.channelMix,
      colorBalance: layer.colorBalance,
      worldMatrix,
      dprScale: 1,
    };
  }

  /**
   * Build a LayerDescriptor from a non-text Layer.
   * Computes content hash from the asset blob for Worker cache keying.
   */
  private async buildDescriptor(layer: Layer): Promise<LayerDescriptor> {
    const raw = this.geometry.transform.getLayerWorldMatrix(layer);
    const worldMatrix = asWorldMatrix(raw);
    const asset = layer.assetId ? this.assets.get(layer.assetId) : undefined;

    // Compute content hash from blob (Worker uses hash as cache key)
    let hash = '';
    if (asset?.blob) {
      hash = await calculateHash(asset.blob);
    }

    return {
      type: layer.type,
      assetId: layer.assetId,
      hash,
      metadata: layer.metadata,
      textData: layer.textData,
      bounding: layer.bounding,
      visibleShape: layer.visibleShape,
      vectorMasks: layer.vectorMasks,
      bitmapMasks: layer.bitmapMasks,
      opacity: layer.opacity,
      blendMode: layer.blendMode ?? 'source-over',
      fill: layer.fill,
      adjustments: layer.adjustments,
      curves: layer.curves,
      levels: layer.levels,
      channelMix: layer.channelMix,
      colorBalance: layer.colorBalance,
      worldMatrix,
      dprScale: asset?.tileMeta?.dprScale ?? 1,
    };
  }

  /**
   * Ensure the Worker's cache contains all blobs needed by the descriptors.
   *
   * Walks each descriptor and its bitmap masks, collects unique hashes,
   * then transfers any missing blobs via bridge.ensureAsset.
   */
  private async ensureAssetsReady(descriptors: LayerDescriptor[]): Promise<void> {
    const hashToBlob = new Map<string, Blob>();

    for (const d of descriptors) {
      // Layer's own image asset
      if (d.hash && d.assetId && (d.type === 'image' || d.type === 'paint')) {
        const asset = this.assets.get(d.assetId);
        if (asset?.blob) {
          hashToBlob.set(d.hash, asset.blob);
        }
      }

      // Bitmap mask assets
      if (d.bitmapMasks) {
        for (const bm of d.bitmapMasks) {
          if (bm.enabled && bm.assetId) {
            const maskAsset = this.assets.get(bm.assetId);
            if (maskAsset?.blob) {
              const maskHash = await calculateHash(maskAsset.blob);
              hashToBlob.set(maskHash, maskAsset.blob);
            }
          }
        }
      }
    }

    // Transfer all needed blobs to Worker in parallel
    const transfers = [...hashToBlob.entries()].map(([hash, blob]) =>
      this.bridge.ensureAsset(hash, blob),
    );

    await Promise.all(transfers);
  }
}
