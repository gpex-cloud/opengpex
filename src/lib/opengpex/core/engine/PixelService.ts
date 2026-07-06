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

import { imageCache } from './cache/ImageCache';
import { tileCache } from './cache/TileCache';
import {
  Layer, PixelService, GeometryService, AssetService, WorkerProxy, Shape, LocalShape, LocalPolygon, Frame, WorkerResult
} from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { PixelUtils } from './PixelUtils';

const pendingLoads = new Map<string, Promise<HTMLImageElement>>();

/**
 * PixelService: Pixel facade service (structured refactored version)
 * Unified exposure of detection (load), processing (worker), and rendering orchestration (render) capabilities.
 */
export function createPixelService(
  geometry: GeometryService,
  assets: AssetService,
  processor: WorkerProxy
): PixelService {

  const service: PixelService = {
    // 1. Resource loading and decoding namespace
    decode: {
      async htmlImage(src: string): Promise<HTMLImageElement> {
        const cached = imageCache.get(src);
        if (cached) return cached;

        const pending = pendingLoads.get(src);
        if (pending) return pending;

        const promise = new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            imageCache.set(src, img);
            pendingLoads.delete(src);
            resolve(img);
          };
          img.onerror = reject;
          img.src = src;
        });

        pendingLoads.set(src, promise);
        return promise;
      },
      async dimensions(src: string, assetId?: string) {
        if (assetId) {
          const meta = assets.get(assetId)?.tileMeta;
          if (meta) return { w: meta.width, h: meta.height };
        }
        const img = await this.htmlImage(src);
        return { w: img.naturalWidth, h: img.naturalHeight };
      },
      async contentBounds(src: string, assetId?: string) {
        if (assetId) {
          const meta = assets.get(assetId)?.tileMeta;
          if (meta?.contentBounds) return geometry.asLocalRect(meta.contentBounds);
        }

        const img = await this.htmlImage(src);
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d', { alpha: true });
        if (!ctx) return geometry.asLocalRect({ x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight });

        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
            if (data[(y * canvas.width + x) * 4 + 3] > 0) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }

        const rect = maxX === -1
          ? { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight }
          : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };

        return geometry.asLocalRect(rect);
      }
    },

    // 2. Image processing namespace
    process: {
      async thumbnail(source: HTMLImageElement | string, maxSize = 256) {
        const img = typeof source === 'string' ? await service.decode.htmlImage(source) : source;
        const dim = { w: img.naturalWidth, h: img.naturalHeight };

        const ratio = dim.w / dim.h;
        const targetDim = ratio > 1
          ? { w: Math.round(maxSize), h: Math.round(maxSize / ratio) }
          : { w: Math.round(maxSize * ratio), h: Math.round(maxSize) };

        // Delegate to Worker for offscreen thumbnail rendering
        const result = await service.worker.resampleImage(img.src, targetDim, {
          format: 'image/webp',
          quality: 0.9
        });

        return result.blob!;
      },
      async resample(src: string, options: { targetSize: { w: number; h: number } }) {
        console.log(`[PixelService] Delegating resample to WorkerProxy for ${src}`);
        const { targetSize } = options;
        const result = await service.worker.resampleImage(src, targetSize);
        return result.blob!;
      },
    },

    // 3. Scene rendering and synthesis namespace
    render: {
      async shapeToBlob(frame: Frame, shape: LocalShape, options: { format?: string; quality?: number } = {}) {
        // Filter: host layers only + exclude hidden layers
        const allHostLayers = LayerFactory.getHostLayers(frame.layers.order.map(id => frame.layers.byId[id]));
        const targetLayers = allHostLayers.filter(l => l.visible !== false);

        if (targetLayers.length === 0) {
          console.warn('[PixelService.shapeToBlob] No visible layers to export. All %d host layers are hidden.', allHostLayers.length);
        } else if (targetLayers.length < allHostLayers.length) {
          console.debug('[PixelService.shapeToBlob] Export: %d/%d layers visible (filtered %d hidden)',
            targetLayers.length, allHostLayers.length, allHostLayers.length - targetLayers.length);
        }

        const worldShape = geometry.shape.localToWorldShape(shape, frame);

        const result = await service.worker.mergeLayersWithShape(targetLayers, worldShape, { targetDpr: 1, ...options });
        if (options.format === 'raw') return result.bitmap!;
        return result.blob!;
      },
      async frameToBlob(frame: Frame, options: { format?: string; quality?: number } = {}) {
        // Filter: host layers only + exclude hidden layers
        const allHostLayers = LayerFactory.getHostLayers(frame.layers.order.map(id => frame.layers.byId[id]));
        const targetLayers = allHostLayers.filter(l => l.visible !== false);

        if (targetLayers.length === 0) {
          console.warn('[PixelService.frameToBlob] No visible layers to export. All %d host layers are hidden.', allHostLayers.length);
        } else if (targetLayers.length < allHostLayers.length) {
          console.debug('[PixelService.frameToBlob] Export: %d/%d layers visible (filtered %d hidden)',
            targetLayers.length, allHostLayers.length, allHostLayers.length - targetLayers.length);
        }

        const fullShape = {
          type: 'rect' as const,
          rect: { x: -frame.canvas.w / 2, y: -frame.canvas.h / 2, w: frame.canvas.w, h: frame.canvas.h },
          hardEdge: false
        } as Shape;

        const result = await service.worker.mergeLayersWithShape(targetLayers, fullShape, { targetDpr: 1, ...options });
        if (options.format === 'raw') return result.bitmap!;
        return result.blob!;
      }
    },

    // 3. Worker-side offscreen calculation namespace
    worker: {
      mergeLayersToLayer: async (target: Layer, items, options?: { targetDpr?: number }) => {
        const targetLayer = target;
        const canvasDim = targetLayer.bounding;
        const targetM = geometry.transform.getLayerWorldMatrix(targetLayer);

        // Automatically include target in the first position of items
        const allWrappedItems: (Layer | { layer: Layer; relative?: boolean })[] = [
          { layer: targetLayer, relative: true },
          ...items
        ];

        // Ensure all layer assets are decoded in Worker cache before merging.
        // The Worker's LRU may have evicted bitmaps+blobs for infrequently-used
        // assets; re-sending the blob guarantees the merger fallback can re-decode.
        await Promise.all(allWrappedItems.map(async item => {
          const layer = ('layer' in item) ? item.layer : (item as Layer);
          const resolvedSrc = assets.resolve(layer.assetId, layer.src);
          if (resolvedSrc) await service.decode.htmlImage(resolvedSrc);
          if (layer.assetId) {
            const asset = assets.get(layer.assetId);
            if (asset?.blob) {
              await processor.ensureAssetInWorker(layer.assetId, asset.blob);
            }
          }
        }));

        const processedItems = allWrappedItems.map((item) => {
          const layer = ('layer' in item) ? item.layer : (item as Layer);
          const isRelative = ('relative' in item) ? item.relative : false;

          // Base projection matrix: converts item to target local space
          const m = (isRelative && targetM)
            ? targetM.inverse().multiply(geometry.transform.getLayerWorldMatrix(layer))
            : new geometry.Matrix(1, 0, 0, 1, 0, 0);

          const finalM = m;

          // 💡 Subpixel Precision Preservation:
          // Remove forced rounding of translation components, retaining full floating-point precision.
          // Completely resolves 0.5px seams/cracks caused by inconsistent rounding directions between frontend and backend when a 0.5 subpixel deviation occurs due to odd-width/height Frame bounding box calculations.

          const asset = layer.assetId ? assets.get(layer.assetId) : null;
          const dprScale = asset?.tileMeta?.dprScale || 1;

          return {
            hash: layer.assetId || '',
            boundingRect: layer.bounding,
            visibleShape: layer.visibleShape,
            opacity: layer.opacity ?? 1,
            adjustments: layer.adjustments,
            vectorMasks: layer.vectorMasks,
            bitmapMasks: layer.bitmapMasks,
            matrix: {
              a: finalM.a, b: finalM.b, c: finalM.c, d: finalM.d, tx: finalM.tx, ty: finalM.ty
            },
            dprScale
          };
        });

        return await processor.mergeLayersToLayer(canvasDim, processedItems, options);
      },
      resampleImage: async (src: string, targetSize: { w: number; h: number }, options?: { format?: string; quality?: number }) => {
        return await processor.resampleImage(src, targetSize, options);
      },
      mergeLayersWithShape: async (layers: Layer[], shape: Shape, options?: { format?: string; quality?: number; targetDpr?: number }) => {
        const canvasDim = { w: shape.rect.w, h: shape.rect.h };

        await Promise.all(layers.map(async layer => {
          const resolvedSrc = assets.resolve(layer.assetId, layer.src);
          return resolvedSrc ? await service.decode.htmlImage(resolvedSrc) : null;
        }));

        // Ensure all bitmapMask assets are decoded into Worker cache
        for (const layer of layers) {
          if (layer.bitmapMasks) {
            for (const bm of layer.bitmapMasks) {
              if (bm.enabled && bm.assetId) {
                const maskAsset = assets.get(bm.assetId);
                if (maskAsset?.blob) {
                  await processor.ensureAssetInWorker(bm.assetId, maskAsset.blob);
                }
              }
            }
          }
        }

        const processedItems = layers.map((layer) => {
          const m = geometry.transform.getLayerWorldMatrix(layer);
          const finalM = new geometry.Matrix(1, 0, 0, 1, -shape.rect.x, -shape.rect.y).multiply(m);

          const asset = layer.assetId ? assets.get(layer.assetId) : null;
          const dprScale = asset?.tileMeta?.dprScale || 1;

          return {
            hash: layer.assetId || '',
            boundingRect: layer.bounding,
            visibleShape: layer.visibleShape,
            opacity: layer.opacity ?? 1,
            adjustments: layer.adjustments,
            vectorMasks: layer.vectorMasks,
            bitmapMasks: layer.bitmapMasks,
            matrix: {
              a: finalM.a, b: finalM.b, c: finalM.c, d: finalM.d, tx: finalM.tx, ty: finalM.ty
            },
            dprScale
          };
        });


        const localShape = {
          ...shape,
          rect: { x: 0, y: 0, w: shape.rect.w, h: shape.rect.h }
        } as LocalShape;

        return await processor.mergeLayersWithShape(canvasDim, localShape, processedItems, options);
      },
      cloneRegion: async (assetId, rect, shape) => {
        return await processor.cloneRegion(assetId, rect, shape);
      },
      bakeMasks: async (assetId, masks) => {
        return await processor.bakeMasks(assetId, masks);
      },
      asAsset: async (promise: Promise<WorkerResult>) => {
        const result = await promise;
        if (!result.hash || !result.blob || !result.tileMeta) {
          throw new Error('WorkerResult is missing required fields (hash, blob, tileMeta) for asset injection.');
        }
        const id = await assets.inject(result.hash, result.blob, result.tileMeta);
        return { id, url: assets.getURL(id)! };
      }
    },

    // 4. Rasterization namespace
    rasterize: {
      async layer(layer) {
        const { drawLayerInstance } = await import('./backends/canvas2d/painter');
        const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
        const w = layer.bounding.w || 1;
        const h = layer.bounding.h || 1;
        const canvas = new OffscreenCanvas(Math.ceil(w * dpr), Math.ceil(h * dpr));
        const ctx = canvas.getContext('2d')!;
        ctx.scale(dpr, dpr);
        drawLayerInstance(ctx, layer, null);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const id = await assets.register(blob, dpr);
        return { id, url: assets.getURL(id)! };
      },

      /**
       * rasterize.mask: Rasterizes a polygon selection into an alpha-channel mask PNG asset.
       * Alpha=255 (opaque) = visible area, Alpha=0 (transparent) = hidden area.
       * The rendering engine uses `destination-in` compositing which operates on alpha,
       * so the mask must encode visibility in the alpha channel (not RGB luminance).
       * Supports feathering via Gaussian blur on the mask edges.
       * Returns { id, url } ready for LayerEditor.applyBitmapMask, or null if bounds invalid.
       */
      async mask(polygon: LocalPolygon, bounds: { w: number; h: number }, feather = 0) {
        const w = Math.ceil(bounds.w);
        const h = Math.ceil(bounds.h);
        if (w <= 0 || h <= 0) return null;

        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d')!;

        // Canvas starts fully transparent (alpha=0 everywhere = hidden)
        // Draw selection polygon as opaque white (alpha=255 = visible)
        ctx.fillStyle = '#ffffff';
        const path = new Path2D();

        // Build path from polygon rings (LocalPolygon.rings: LocalPoint[][])
        const rings = polygon.rings;
        for (let r = 0; r < rings.length; r++) {
          const ring = rings[r];
          if (ring && ring.length > 0) {
            path.moveTo(ring[0].x, ring[0].y);
            for (let i = 1; i < ring.length; i++) {
              path.lineTo(ring[i].x, ring[i].y);
            }
            path.closePath();
          }
        }

        ctx.fill(path, 'evenodd');

        // Apply feather via Gaussian blur (if requested)
        // Blur on the alpha channel creates a soft transition at edges
        if (feather > 0) {
          const blurCanvas = new OffscreenCanvas(w, h);
          const blurCtx = blurCanvas.getContext('2d')!;
          blurCtx.filter = `blur(${feather}px)`;
          blurCtx.drawImage(canvas, 0, 0);
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(blurCanvas, 0, 0);
        }

        // Export as PNG and register in asset service
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const id = await assets.register(blob);
        const url = assets.getURL(id);
        if (!url) return null;
        return { id, url };
      }
    },

    // 5. Utility namespace
    utils: {
      getRenderPipeline: PixelUtils.getRenderPipeline,
      fetchFromUrl: PixelUtils.fetchFromUrl,
      download: PixelUtils.download,
      probeEngines: PixelUtils.probeEngines,
    },

    // 5. Cache management namespace (keep as is)
    cache: {
      clear: () => {
        imageCache.clear();
        tileCache.clear();
      }
    }
  };
  return service;
}

