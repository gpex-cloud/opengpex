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

import { Layer, ClipDescriptor, SupportedImageFormat, EngineStatus, TileMetadata, TileData, IMatrix3x3, LocalRect } from '@opengpex/editor/core/types';

/**
 * PixelUtils: Pure utility functions related to pixel processing and rendering
 * Completely decoupled, independent of any external service instances, facilitating sharing across multiple threads (main thread + Worker).
 */
export const PixelUtils = {
  /**
   * Converts Canvas to Blob
   * Compatible with main thread (HTMLCanvasElement) and Worker (OffscreenCanvas).
   */
  canvasToBlob(canvas: HTMLCanvasElement | OffscreenCanvas, format = 'image/png', quality = 0.92): Promise<Blob> {
    return new Promise((resolve) => {
      if (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement) {
        canvas.toBlob((blob) => resolve(blob!), format, quality);
      } else {
        (canvas as OffscreenCanvas).convertToBlob({ type: format, quality }).then(resolve);
      }
    });
  },

  /**
   * Asynchronous hash calculation (SHA-256)
   */
  async calculateHash(blob: Blob): Promise<string> {
    const arrayBuffer = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  },

  /**
   * Scans visible region of a bitmap (Content Bounds Detection)
   */
  async calculateContentBounds(bitmap: ImageBitmap): Promise<LocalRect> {
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const offCtx2d = canvas.getContext('2d', { alpha: true });
    if (!offCtx2d) return { x: 0, y: 0, w: width, h: height } as LocalRect;

    offCtx2d.drawImage(bitmap, 0, 0);
    const imageData = offCtx2d.getImageData(0, 0, width, height);
    const data = imageData.data;

    let minX = width, minY = height, maxX = -1, maxY = -1;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const alpha = data[(y * width + x) * 4 + 3];
        if (alpha > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX === -1) {
      return { x: 0, y: 0, w: width, h: height } as LocalRect;
    }

    return {
      x: minX,
      y: minY,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
      __brand: 'local'
    } as LocalRect;
  },

  /**
   * Wraps unified return protocol: Blob + Hash + Metadata
   */
  async wrapResult(blob: Blob, dprScale?: number) {
    const hash = await PixelUtils.calculateHash(blob);
    const bitmap = await createImageBitmap(blob);
    const contentBounds = await PixelUtils.calculateContentBounds(bitmap);
    
    const tileMeta = {
      width: bitmap.width,
      height: bitmap.height,
      contentBounds,
      tileSize: 256,
      cols: Math.ceil(bitmap.width / 256),
      rows: Math.ceil(bitmap.height / 256),
      levels: 1,
      isTiled: true, // Must be marked as true, otherwise new URL cannot be dynamically resolved after refresh
      dprScale
    };

    // Release temporary bitmap
    bitmap.close();

    return { blob, hash, tileMeta };
  },

  /**
   * getRenderPipeline: Converts layer viewport and masks into abstract clipping instructions.
   */
  getRenderPipeline(layer: Layer): ClipDescriptor[] {
    const pipeline: ClipDescriptor[] = [];
    if (layer.visibleShape) {
      pipeline.push({ shape: layer.visibleShape, inverted: false });
    }
    const activeMasks = layer.vectorMasks?.filter(m => m.enabled);
    if (activeMasks) {
      for (const mask of activeMasks) {
        pipeline.push({ shape: mask.shape, inverted: mask.inverted });
      }
    }
    return pipeline;
  },

  /**
   * Computes and assembles tile task queue required for rendering (Data-Driven Tiling)
   * Supports object pool reuse to achieve Zero-Allocation.
   */
  computeTileJobs(
    layerAssetId: string,
    tileMeta: TileMetadata,
    matrix: IMatrix3x3 | { a: number; b: number; c: number; d: number; tx: number; ty: number } | undefined,
    drawRect: { x: number; y: number; w: number; h: number } | undefined,
    isExporting: boolean,
    tilePool: TileData[],
    tileSource: { get(assetId: string, level: number, x: number, y: number): ImageBitmap | HTMLImageElement | null | undefined }
  ): number {
    const { tileSize, width, height, levels } = tileMeta;
    const s = tileMeta.dprScale || 1;
    const scaleX = matrix ? Math.sqrt(matrix.a * matrix.a + matrix.b * matrix.b) : 1;
    const visualScaleX = scaleX / s;
    const level = Math.max(0, Math.min(Math.floor(Math.log2(1 / visualScaleX)), levels - 1));
    const ratio = Math.pow(2, level);
    const scaledTileSize = tileSize * ratio;

    const logicalWidth = width / s;
    const logicalHeight = height / s;
    const dRect = drawRect || { x: 0, y: 0, w: logicalWidth, h: logicalHeight };

    const overlap = isExporting ? 0 : (1.0 / (ratio * visualScaleX));

    const physicalDRect = {
      x: dRect.x * s,
      y: dRect.y * s,
      w: dRect.w * s,
      h: dRect.h * s
    };

    const startCol = Math.max(0, Math.floor(physicalDRect.x / scaledTileSize));
    const endCol = Math.min(Math.ceil(width / scaledTileSize) - 1, Math.ceil((physicalDRect.x + physicalDRect.w) / scaledTileSize));
    const startRow = Math.max(0, Math.floor(physicalDRect.y / scaledTileSize));
    const endRow = Math.min(Math.ceil(height / scaledTileSize) - 1, Math.ceil((physicalDRect.y + physicalDRect.h) / scaledTileSize));

    let tileCount = 0;

    for (let y = startRow; y <= endRow; y++) {
      for (let x = startCol; x <= endCol; x++) {
        const bitmap = tileSource.get(layerAssetId, level, x, y);
        if (bitmap) {
          if (tileCount >= tilePool.length) {
            tilePool.push({
              bitmap,
              x: (x * scaledTileSize) / s,
              y: (y * scaledTileSize) / s,
              scale: ratio / s,
              overlap
            });
          } else {
            const tile = tilePool[tileCount];
            tile.bitmap = bitmap;
            tile.x = (x * scaledTileSize) / s;
            tile.y = (y * scaledTileSize) / s;
            tile.scale = ratio / s;
            tile.overlap = overlap;
          }
          tileCount++;
        }
      }
    }

    return tileCount;
  },

  /**
   * Detects file format
   */
  detectFormat(file: File): SupportedImageFormat {
    const type = file.type.toLowerCase();
    const name = file.name.toLowerCase();
    if (type === 'image/jpeg' || name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'jpeg';
    if (type === 'image/png' || name.endsWith('.png')) return 'png';
    if (type === 'image/webp' || name.endsWith('.webp')) return 'webp';
    if (type === 'image/avif' || name.endsWith('.avif')) return 'avif';
    if (type === 'image/heic' || type === 'image/heif' || name.endsWith('.heic') || name.endsWith('.heif')) return 'heic';
    if (type === 'image/svg+xml' || name.endsWith('.svg')) return 'svg';
    return 'unknown';
  },


  /**
   * Fetches image from URL and converts to File object
   */
  async fetchFromUrl(url: string): Promise<File> {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Network response was not ok');
    const blob = await response.blob();
    const filename = url.split('/').pop() || 'downloaded-image';
    return new File([blob], filename, { type: blob.type });
  },

  /**
   * Triggers browser download
   */
  async download(blob: Blob, name: string): Promise<void> {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  },

  /**
   * Detects engine state
   */
  probeEngines(): EngineStatus[] {
    return [{ id: 'canvas2d', name: 'Canvas2D Engine (Atomic)', status: 'ready' }];
  },

  /**
   * Gets export filename
   */
  async getExportFilename(n: string, w: number, h: number, e: string): Promise<string> {
    return `${n}-${w}x${h}.${e}`;
  }
};
