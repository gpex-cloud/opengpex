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

import {
  GeometryService, PixelService,
  Frame, Layer, VectorMask,
  asLocalShape, asLocalRect
} from '@opengpex/editor/core/types';
import { LayerFactory } from '../factory';

/**
 * createResampleOperations: Factory that creates layer resampling operations
 * with access to the required service dependencies.
 */
export function createResampleOperations(
  geometry: GeometryService,
  pixels: PixelService
) {
  /**
   * resampleLayerPhysical: Physically resamples a layer's pixel content.
   * Adjusts pixel resolution and proportionally scales visible areas and masks.
   *
   * Uniform scale: resample source directly, preserve masks/visibleShape.
   * Non-uniform scale: bake (flatten) then resample, reset orientation.
   */
  async function resampleLayerPhysical(
    layer: Layer,
    scaleX: number,
    scaleY: number,
    frame: Frame
  ): Promise<{ newUrl: string; newAssetId: string; patch: Partial<Layer> } | null> {
    try {
      const hasContent = layer.src && layer.src !== LayerFactory.TRANSPARENT_PIXEL;
      const isUniform = Math.abs(scaleX - scaleY) < 0.001;

      if (isUniform) {
        // ── Uniform scale: resample source directly, preserve masks/visibleShape ──
        const targetW = Math.max(1, Math.round(layer.bounding.w * scaleX));
        const targetH = Math.max(1, Math.round(layer.bounding.h * scaleY));

        let assetId = layer.assetId;
        let url = layer.src;

        if (hasContent) {
          const result = await pixels.image.resample(layer.src, {
            targetSize: { w: targetW, h: targetH },
          });
          ({ assetId, url } = await result.toAsset());
        }

        const scaleRect = (r: { x: number; y: number; w: number; h: number }) =>
          asLocalRect({ x: r.x * scaleX, y: r.y * scaleY, w: r.w * scaleX, h: r.h * scaleY });

        const patch: Partial<Layer> = {
          src: url, assetId,
          cx: layer.cx * scaleX,
          cy: layer.cy * scaleY,
          bounding: { w: targetW, h: targetH },
          scale: 1,
          ...(layer.visibleShape && { visibleShape: { ...layer.visibleShape, rect: scaleRect(layer.visibleShape.rect) } }),
          ...(layer.vectorMasks && {
            vectorMasks: layer.vectorMasks.map((m: VectorMask) => ({
              ...m, shape: { ...m.shape, rect: scaleRect(m.shape.rect) },
            })),
          }),
        };

        return { newUrl: url, newAssetId: assetId || '', patch };
      } else {
        // ── Non-uniform scale: bake (flatten) then resample, reset orientation ──
        const aabb = geometry.space.getLayerBoundingBox(layer);
        const targetW = Math.max(1, Math.round(aabb.w * scaleX));
        const targetH = Math.max(1, Math.round(aabb.h * scaleY));

        let assetId = layer.assetId;
        let url = layer.src;

        if (hasContent) {
          const { result } = await pixels.render.compositeResizedLayers([layer], frame, { w: targetW, h: targetH });
          ({ assetId, url } = await result.toAsset());
        }

        const patch: Partial<Layer> = {
          src: url, assetId,
          cx: (aabb.x + aabb.w / 2) * scaleX,
          cy: (aabb.y + aabb.h / 2) * scaleY,
          bounding: { w: targetW, h: targetH },
          scale: 1, rotation: 0, flip: { h: false, v: false },
          visibleShape: asLocalShape({ x: 0, y: 0, w: targetW, h: targetH }),
          vectorMasks: [],
        };

        return { newUrl: url, newAssetId: assetId || '', patch };
      }
    } catch (err) {
      console.error('[LayerService] Resample physical failed for layer:', layer.id, err);
      return null;
    }
  }

  return { resampleLayerPhysical };
}
