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
  Frame, Layer, VectorMask, BitmapMask, LocalRect,
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
   * resampleLayer: Resamples a layer's pixel content to a new resolution.
   *
   * Uniform scale (|scaleX - scaleY| < 0.001):
   *   Non-destructive. The shared source is resampled by its TRUE pixel
   *   dimensions × scale (NOT bounding × scale — see resize spec §4.1), and every
   *   geometric attribute (visibleShape rect + pathData, vectorMasks rect +
   *   pathData + feather, bitmapMasks bounds + feather + grayscale src,
   *   adjustments.blur, textData fontSize/box) is mapped from the old coordinate
   *   system to the new one.
   *   Zero-copy sharing, visibleShape offset semantics and the full mask list are
   *   all preserved; only the pixel resolution changes.
   *
   * Non-uniform scale:
   *   Destructive bake (flatten) then resample, resetting orientation. Vector /
   *   bitmap masks and the visibleShape offset are collapsed into the baked pixels
   *   (known trade-off, see spec §7). Also used as the safety fallback when the
   *   uniform path cannot resolve the source's true dimensions (spec §4.1 / §12.2)
   *   — we NEVER fall back to the old buggy `bounding × scale` behavior.
   */
  async function resampleLayer(
    frame: Frame,
    layer: Layer,
    scaleX: number,
    scaleY: number
  ): Promise<{ newUrl: string; newAssetId: string; patch: Partial<Layer> } | null> {
    const hasContent = layer.src && layer.src !== LayerFactory.TRANSPARENT_PIXEL;
    const isUniform = Math.abs(scaleX - scaleY) < 0.001;

    // ── Non-uniform scale / uniform fallback: bake (flatten) then resample ──
    async function flattenResample(): Promise<{ newUrl: string; newAssetId: string; patch: Partial<Layer> }> {
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

    try {
      if (!isUniform) {
        return await flattenResample();
      }
      return await resampleUniform();
    } catch (err) {
      // Uniform path failed (e.g. src decode failed / asset missing). Fall back to
      // the flatten path — correct pixels, degraded structure — NEVER the old buggy
      // bounding × scale behavior (spec §4.1 / §12.2).
      if (isUniform) {
        try {
          console.warn('[LayerService] Uniform resample failed, falling back to flatten for layer:', layer.id, err);
          return await flattenResample();
        } catch (fallbackErr) {
          console.error('[LayerService] Resample flatten fallback failed for layer:', layer.id, fallbackErr);
          return null;
        }
      }
      console.error('[LayerService] Resample failed for layer:', layer.id, err);
      return null;
    }

    // ── Uniform scale: non-destructive resample of the shared source ──
    async function resampleUniform(): Promise<{ newUrl: string; newAssetId: string; patch: Partial<Layer> }> {
      // Bounding is the "selection window" size — scale it independently of the
      // source's true pixel dimensions (they are two distinct quantities). Bitmaps
      // must have integer sizes, so round + clamp (matches prior behavior).
      const boundingW = Math.max(1, Math.round(layer.bounding.w * scaleX));
      const boundingH = Math.max(1, Math.round(layer.bounding.h * scaleY));

      // Uniform branch guarantees scaleX ≈ scaleY, so a single scalar safely
      // covers px-quantity attributes (feather / blur). See spec §4.6.
      const featherScale = scaleX;

      let assetId = layer.assetId;
      let url = layer.src;

      if (hasContent) {
        // Route X (spec §4.1): resample by the source's TRUE dimensions × scale.
        // The Worker resolves src size, so a shared full-image src scales correctly
        // instead of being squashed into the selection window. Throws on decode
        // failure → caught above → flatten fallback.
        const result = await pixels.image.resample(layer.src, { scale: scaleX });
        ({ assetId, url } = await result.toAsset());
      }

      // Snap "positioning" quantities (rect / bounds) to the integer pixel grid to
      // avoid sub-pixel AA blur / seams (spec §5). pathData vertices are NOT snapped
      // (they are a sub-pixel-precise clip source); the enclosing rect carries the
      // alignment instead.
      const scaleRectSnap = (r: { x: number; y: number; w: number; h: number }): LocalRect =>
        geometry.snapping.snapToPixel(
          asLocalRect({ x: r.x * scaleX, y: r.y * scaleY, w: r.w * scaleX, h: r.h * scaleY }),
          'round'
        );

      // Half-pixel alignment for layer center world coords (same convention as
      // resizeCanvas): even dimensions → integer, odd → x.5.
      const snapHalf = (v: number) => Math.round(v * 2) / 2;

      // visibleShape: rect (scale + snap) + pathData (scale only) — spec §4.2.
      let visibleShapePatch: Partial<Layer> = {};
      if (layer.visibleShape) {
        const vs = layer.visibleShape;
        const nextVs = { ...vs, rect: scaleRectSnap(vs.rect) };
        if (vs.pathData) {
          (nextVs as { pathData?: string }).pathData = geometry.shape.scalePathData(vs.pathData, scaleX, scaleY);
        }
        visibleShapePatch = { visibleShape: nextVs };
      }

      // vectorMasks: rect (scale + snap) + pathData (scale) + feather (scale) — spec §4.3.
      // All other fields (inverted / enabled / reserved / assocLayerId / id) preserved.
      let vectorMasksPatch: Partial<Layer> = {};
      if (layer.vectorMasks) {
        vectorMasksPatch = {
          vectorMasks: layer.vectorMasks.map((m: VectorMask) => {
            const nextShape = { ...m.shape, rect: scaleRectSnap(m.shape.rect) };
            if (m.shape.pathData) {
              (nextShape as { pathData?: string }).pathData = geometry.shape.scalePathData(m.shape.pathData, scaleX, scaleY);
            }
            return { ...m, shape: nextShape, feather: m.feather * featherScale };
          }),
        };
      }

      // bitmapMasks: bounds (scale + snap) + feather (scale) + grayscale src resample — spec §4.4.
      // The grayscale src is independent (not shared), so it must be resampled to
      // match the new bounds size. All other fields (inverted / enabled / tag / id) preserved.
      let bitmapMasksPatch: Partial<Layer> = {};
      if (layer.bitmapMasks && layer.bitmapMasks.length > 0) {
        const nextBitmapMasks = await Promise.all(
          layer.bitmapMasks.map(async (bm: BitmapMask) => {
            const scaledBounds = scaleRectSnap(bm.bounds);
            const targetSize = { w: Math.max(1, scaledBounds.w), h: Math.max(1, scaledBounds.h) };
            const bmResult = await pixels.image.resample(bm.src, { targetSize });
            const { assetId: bmAssetId, url: bmUrl } = await bmResult.toAsset();
            return {
              ...bm,
              bounds: scaledBounds,
              feather: bm.feather * featherScale,
              src: bmUrl,
              assetId: bmAssetId,
            };
          })
        );
        bitmapMasksPatch = { bitmapMasks: nextBitmapMasks };
      }

      // adjustments.blur: px-quantity → scale. Only rewrite when blur > 0 to avoid
      // an unnecessary patch (spec §4.5).
      let adjustmentsPatch: Partial<Layer> = {};
      if (layer.adjustments && layer.adjustments.blur > 0) {
        adjustmentsPatch = {
          adjustments: { ...layer.adjustments, blur: layer.adjustments.blur * featherScale },
        };
      }

      // textData: text layers render LIVE from textData via fillText (their src is the
      // transparent pixel), so bounding/visibleShape scaling alone leaves the glyphs at
      // the old size. Scale the px-quantity fields (fontSize + fixed-box dims) by the
      // uniform factor so text grows/shrinks with the document. `lineHeight` is a
      // UNITLESS multiplier of fontSize — it must NOT be scaled (fontSize already carries
      // the size change); font family / weight / color / align are style, left untouched.
      let textDataPatch: Partial<Layer> = {};
      if (layer.type === 'text' && layer.textData) {
        const td = layer.textData;
        textDataPatch = {
          textData: {
            ...td,
            fontSize: td.fontSize * featherScale,
            ...(td.boxWidth != null ? { boxWidth: td.boxWidth * featherScale } : {}),
            ...(td.boxHeight != null ? { boxHeight: td.boxHeight * featherScale } : {}),
          },
        };
      }

      const patch: Partial<Layer> = {
        src: url, assetId,
        cx: snapHalf(layer.cx * scaleX),
        cy: snapHalf(layer.cy * scaleY),
        bounding: { w: boundingW, h: boundingH },
        scale: 1,
        ...visibleShapePatch,
        ...vectorMasksPatch,
        ...bitmapMasksPatch,
        ...adjustmentsPatch,
        ...textDataPatch,
      };

      return { newUrl: url, newAssetId: assetId || '', patch };
    }
  }

  return { resampleLayer };
}
