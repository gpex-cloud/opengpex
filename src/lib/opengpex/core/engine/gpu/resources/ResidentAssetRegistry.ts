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
 * ResidentAssetRegistry.ts — Resident GPU asset, 1D LUT, and 3D LUT registry.
 *
 * Owns texture upload, content-based deduplication, per-asset epoch tracking
 * (for composite-signature invalidation), and the alpha->red scratch canvas for
 * single-channel bitmap masks.
 *
 * @module core/gpu/resources/ResidentAssetRegistry
 */

import { LayerTexture } from './LayerTexture';
import { GPUTextureUsage } from '../constants';
import type { UploadSource, LutUpload } from '@opengpex/editor/core/engine/pipeline/IEngine';
import type { Lut3dUpload } from '@opengpex/editor/core/engine/pipeline/scene/lut3dPlan';

export interface ResidentAssetHost {
  isReady(): boolean;
  getDevice(): GPUDevice | null;
}

export class ResidentAssetRegistry {
  private readonly assets = new Map<string, LayerTexture>();
  private readonly luts = new Map<string, { texture: GPUTexture; view: GPUTextureView }>();
  private readonly luts3d = new Map<string, { texture: GPUTexture; view: GPUTextureView }>();
  private readonly assetMeta = new Map<
    string,
    { source: ImageBitmap | VideoFrame | OffscreenCanvas | Float32Array | Uint16Array; version?: number }
  >();
  private readonly assetEpochs = new Map<string, number>();
  private assetEpochVersion = 0;
  private alphaRedScratch: OffscreenCanvas | HTMLCanvasElement | null = null;

  constructor(private readonly host: ResidentAssetHost) {}

  getAssetsMap(): Map<string, LayerTexture> {
    return this.assets;
  }

  getAssetEpoch(assetId: string): number {
    return this.assetEpochs.get(assetId) ?? 0;
  }

  getEpochVersion(): number {
    return this.assetEpochVersion;
  }

  has(assetId: string): boolean {
    return this.assets.has(assetId);
  }

  uploadSource(assetId: string, src: UploadSource, version?: number): void {
    if (!this.host.isReady()) return;

    const existing = this.assets.get(assetId);
    const meta = this.assetMeta.get(assetId);
    if (existing && meta) {
      const unchanged =
        version !== undefined ? meta.version === version : meta.source === src.data;
      if (unchanged) return;
    }

    const device = this.host.getDevice()!;
    this.release(assetId);

    let layerTex: LayerTexture;

    if (src.kind === 'bitmap') {
      const bitmap = src.data;
      const width = 'displayWidth' in bitmap ? bitmap.displayWidth : bitmap.width;
      const height = 'displayHeight' in bitmap ? bitmap.displayHeight : bitmap.height;

      const isMask = src.channel === 'r';
      const copySource: ImageBitmap | VideoFrame | OffscreenCanvas | HTMLCanvasElement = isMask
        ? this.maskAlphaToRed(bitmap, width, height)
        : bitmap;
      const format: GPUTextureFormat = isMask ? 'r8unorm' : 'rgba8unorm';

      const texture = device.createTexture({
        size: [width, height, 1],
        format,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
        label: `LayerAsset (${assetId})`,
      });

      const destColorSpace: GPUPredefinedColorSpace =
        src.gamut === 'display-p3' ? 'display-p3' : 'srgb';

      device.queue.copyExternalImageToTexture(
        { source: copySource },
        { texture, colorSpace: destColorSpace },
        [width, height],
      );

      layerTex = new LayerTexture({ texture, width, height, format });
    } else {
      const { w, h, format } = src.desc;
      const bytesPerPixel = format === 'rgba32float' ? 16 : 8;

      const texture = device.createTexture({
        size: [w, h, 1],
        format,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
        label: `LayerAsset (${assetId})`,
      });

      device.queue.writeTexture(
        { texture },
        src.data,
        { bytesPerRow: w * bytesPerPixel, rowsPerImage: h },
        [w, h, 1],
      );

      layerTex = new LayerTexture({ texture, width: w, height: h, format });
    }

    this.assets.set(assetId, layerTex);
    this.assetMeta.set(assetId, { source: src.data, version });
    this.assetEpochs.set(assetId, (this.assetEpochs.get(assetId) ?? 0) + 1);
    this.assetEpochVersion++;
  }

  release(assetId: string): void {
    const layerTex = this.assets.get(assetId);
    if (layerTex) {
      layerTex.destroy();
      this.assets.delete(assetId);
    }
    this.assetMeta.delete(assetId);
  }

  hasLut(lutId: string): boolean {
    return this.luts.has(lutId);
  }

  uploadLut(lut: LutUpload): void {
    if (!this.host.isReady()) return;
    if (this.luts.has(lut.lutId)) return;

    const device = this.host.getDevice()!;
    const rows = Math.max(1, lut.rows);
    const texture = device.createTexture({
      size: [lut.width, rows, 1],
      dimension: '2d',
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: `LUT atlas (${lut.lutId})`,
    });
    device.queue.writeTexture(
      { texture },
      lut.data,
      { bytesPerRow: lut.width * 8, rowsPerImage: rows },
      [lut.width, rows, 1],
    );
    this.luts.set(lut.lutId, { texture, view: texture.createView({ dimension: '2d' }) });
  }

  releaseLut(lutId: string): void {
    const entry = this.luts.get(lutId);
    if (entry) {
      entry.texture.destroy();
      this.luts.delete(lutId);
    }
  }

  getLutView(lutId: string): GPUTextureView | undefined {
    return this.luts.get(lutId)?.view;
  }

  hasLut3d(lutId: string): boolean {
    return this.luts3d.has(lutId);
  }

  uploadLut3d(lut: Lut3dUpload): void {
    if (!this.host.isReady()) return;
    if (this.luts3d.has(lut.lutId)) return;

    const device = this.host.getDevice()!;
    const texture = device.createTexture({
      size: [lut.size, lut.size, lut.size],
      dimension: '3d',
      format: lut.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: `LUT3D (${lut.lutId})`,
    });
    device.queue.writeTexture(
      { texture },
      lut.data,
      { bytesPerRow: lut.bytesPerRow, rowsPerImage: lut.size },
      [lut.size, lut.size, lut.size],
    );
    this.luts3d.set(lut.lutId, { texture, view: texture.createView({ dimension: '3d' }) });
  }

  releaseLut3d(lutId: string): void {
    const entry = this.luts3d.get(lutId);
    if (entry) {
      entry.texture.destroy();
      this.luts3d.delete(lutId);
    }
  }

  getLut3dView(lutId: string): GPUTextureView | undefined {
    return this.luts3d.get(lutId)?.view;
  }

  clear(): void {
    for (const asset of this.assets.values()) {
      asset.destroy();
    }
    this.assets.clear();
    this.assetMeta.clear();
    for (const entry of this.luts.values()) {
      entry.texture.destroy();
    }
    this.luts.clear();
    for (const entry of this.luts3d.values()) {
      entry.texture.destroy();
    }
    this.luts3d.clear();
    this.assetEpochs.clear();
    this.assetEpochVersion++;
  }

  private maskAlphaToRed(
    bitmap: ImageBitmap | VideoFrame | OffscreenCanvas,
    width: number,
    height: number,
  ): OffscreenCanvas | HTMLCanvasElement {
    if (!this.alphaRedScratch) {
      this.alphaRedScratch =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(width, height)
          : document.createElement('canvas');
    }
    const scratch = this.alphaRedScratch;
    if (scratch.width !== width) scratch.width = width;
    if (scratch.height !== height) scratch.height = height;
    const ctx = scratch.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) {
      throw new Error('2D context unavailable for mask alpha→red upload conversion');
    }
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap as CanvasImageSource, 0, 0, width, height);
    return scratch;
  }
}
