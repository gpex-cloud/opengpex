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
  Frame, Layer, LocalShape, LocalPolygon,
  asLocalShape, isPolygon
} from '@opengpex/editor/core/types';
import { polygonToShape } from '@opengpex/editor/core/helpers/path2d';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { isBoundingRing, point2dToLocalShape } from '@opengpex/editor/core/geometry/operators/point2d';
import { LayerFactory } from '../factory';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * FragmentResult: Unified result from all fragment operations.
 *
 * Provides enough information for callers to:
 * - Add the fragment layer (newLayer)
 * - Punch a hole in the source layer for cut operations (holeMask)
 */
export interface FragmentResult {
  newLayer: Layer;
  localShape: LocalShape;
  invertedRegular: boolean;
  /** Pre-computed hole mask for cut mode — callers apply this to the source layer */
  holeMask?: { shape: LocalShape; inverted: boolean; feather: number; maskId: string; assocLayerId: string };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shape Resolution
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * resolveLocalShape: Resolve the selection box into a LocalShape in the target layer's local coordinates.
 *
 * Special handling for "inverted regular" polygons:
 *   When a rect/ellipse is inverted (Cmd+Shift+I), it becomes a polygon with
 *   [canvasBoundaryRing, originalShapeRing]. If we naively convert this to a
 *   `type:'path'` shape, the path renderer applies anti-aliasing at the inner
 *   ring boundary — causing visible seams against the original pixel-perfect
 *   rect/ellipse mask from a prior cut/copy.
 *
 *   Detection: 2-ring polygon where ring[0] ≈ canvas boundary and ring[1] is
 *   recognizable as a rect (4 axis-aligned points) or ellipse (64-point fit).
 *   When detected, we extract the inner ring as a proper LocalShape and signal
 *   `invertedRegular: true` so callers can flip their mask inversion flag —
 *   achieving the same visual result with pixel-perfect boundaries.
 */
export function resolveLocalShape(
  box: LocalPolygon,
  frame: Frame,
  layer: Layer,
  geometry: GeometryService
): { shape: LocalShape; invertedRegular: boolean } {
  const layerPoly = geometry.polygon.frameLocalToLayerLocal(box, frame, layer);

  // Detect "inverted regular" pattern: [canvasBoundary, regularShape]
  if (layerPoly.rings.length === 2) {
    const outerRing = layerPoly.rings[0];
    const innerRing = layerPoly.rings[1];
    const layerW = layer.bounding.w;
    const layerH = layer.bounding.h;

    if (isBoundingRing(outerRing, layerW, layerH)) {
      const innerShape = point2dToLocalShape([innerRing], box.antiAliased ?? true);
      if (innerShape) {
        return { shape: innerShape, invertedRegular: true };
      }
    }
  }

  return { shape: polygonToShape(layerPoly), invertedRegular: false };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Fragment Operations Factory
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * createFragmentOperations: Factory that creates all fragment-related operations
 * with access to the required service dependencies.
 */
export function createFragmentOperations(
  geometry: GeometryService,
  pixels: PixelService
) {

  // ─── fragmentToNewLayer (Unified Entry Point) ────────────────────────────────
  /**
   * fragmentToNewLayer: Unified entry point for all fragment operations.
   *
   * Simple two-path routing:
   *   1. Try logical (geometric crop) — zero overhead, lossless, precise bounding.
   *   2. Fallback to vectorMask — for feather, invertedRegular, or when logical
   *      cannot produce a result (e.g. selection entirely outside layer bounds).
   *
   * Callers use this for both Copy and Cut:
   * - Copy: just add result.newLayer
   * - Cut: add result.newLayer + punch hole using result.sourceHole
   */
  async function fragmentToNewLayer(
    frame: Frame,
    layer: Layer,
    options?: { feather?: number; mode?: 'copy' | 'cut' }
  ): Promise<FragmentResult | null> {
    const box = getClipBox(frame);
    if (!box) return null;

    const feather = options?.feather ?? 0;
    const { shape: localShape, invertedRegular } = resolveLocalShape(box, frame, layer, geometry);

    let newLayer: Layer;

    // ── Path decision: logical first, vectorMask fallback ──────────────────────
    // Logical is only viable when feather=0, not invertedRegular, and the
    // geometry service can compute a valid intersection.
    const intersection = (feather === 0 && !invertedRegular)
      ? geometry.shape.intersectWithLayer(localShape, layer)
      : null;

    if (intersection) {
      // ═══ Logical path: geometric crop — same source image, narrowed visibleShape ═══
      const { id: _oldId, ...layerData } = layer;
      newLayer = LayerFactory.getNewLayer({
        ...layerData,
        vectorMasks: layerData.vectorMasks?.filter(m => !m.reserved) || [],
        name: LayerFactory.getNewLayerName(frame.layers.order.map(id => frame.layers.byId[id])),
        hostId: undefined
      });

      const v = intersection.visibleShape.rect;
      newLayer.bounding = { w: v.w, h: v.h };
      newLayer.visibleShape = { ...intersection.visibleShape };
      const pose = geometry.transform.computeFragmentCenter(intersection.center, { x: v.x, y: v.y }, layer.rotation, layer.flip);
      newLayer.cx = pose.x;
      newLayer.cy = pose.y;
      newLayer.birthCenter = { cx: newLayer.cx, cy: newLayer.cy };
      newLayer.metadata = { ...newLayer.metadata, physicalPixels: false };

      if (frame.latestClipTool) {
        newLayer.metadata = { ...newLayer.metadata, clipTool: frame.latestClipTool };
      }

    } else {
      // ═══ VectorMask path: full layer + mask for visibility control ═══
      const { id: _id, hostId: _pid, role: _role, locked: _locked, interactive: _inter, ...layerData } = layer;
      newLayer = LayerFactory.getNewLayer({
        ...layerData,
        name: LayerFactory.getNewLayerName(frame.layers.order.map(id => frame.layers.byId[id])),
        vectorMasks: [],
      });

      // invertedRegular → inverted=true → "show everything except shape" (pixel-perfect)
      // normal → inverted=false → "show only the shape area"
      newLayer.vectorMasks = [LayerFactory.getNewVectorMask(localShape, { inverted: invertedRegular, feather })];

      if (frame.latestClipTool) {
        newLayer.metadata = { ...newLayer.metadata, clipTool: frame.latestClipTool };
      }

    }

    const baseResult: FragmentResult = { newLayer, localShape, invertedRegular };

    // ═══ Cut mode: generate hole mask descriptor + bidirectional pointers ═══
    if (options?.mode === 'cut') {
      const maskId = `mask-hole-${newLayer.id}`;

      baseResult.holeMask = {
        shape: localShape,
        inverted: !invertedRegular,
        feather,
        maskId,
        assocLayerId: newLayer.id,
      };

      newLayer.metadata = {
        ...newLayer.metadata,
        sourceLayerId: layer.id,
        assocMaskId: maskId,
      };
    }

    // ═══ Copy mode (or any non-cut): write sourceLayerId for lineage tracking ═══
    if (options?.mode === 'copy' || !options?.mode) {
      newLayer.metadata = {
        ...newLayer.metadata,
        sourceLayerId: layer.id,
      };
    }

    return baseResult;
  }

  // ─── fragmentToNewLayerPhysical ──────────────────────────────────────────────
  /**
   * Physical path: Composites the layer content within the selection, trims
   * transparent pixels, and registers the result as a new asset.
   * Used exclusively for clipboard export (always needs a real PNG blob).
   */
  async function fragmentToNewLayerPhysical(
    frame: Frame,
    layer: Layer
  ): Promise<{ newLayer: Layer; localShape: LocalShape; url: string } | null> {
    const box = getClipBox(frame);
    if (!box) return null;
    const localShape = polygonToShape(geometry.polygon.frameLocalToLayerLocal(box, frame, layer));
    const intersection = geometry.shape.intersectWithLayer(localShape, layer);
    if (!intersection) return null;

    // For pixel rasterization, use frame-local shape as composite ROI
    const frameLocalShape = polygonToShape(box);
    const worldSelection = geometry.shape.localToWorldShape(frameLocalShape, frame);

    // ── Composite + trim in memory (no intermediate asset registration) ────
    const { result: fragResult } = await pixels.render.compositeLayers([layer], frame, frameLocalShape);
    const trimResult = await fragResult.trimmed();
    if (!trimResult) return null; // Entirely transparent — no content in selection

    const { result: trimmedResult, offset } = trimResult;
    const trimW = trimmedResult.bounds.w;
    const trimH = trimmedResult.bounds.h;
    const { assetId, url: assetUrl } = await trimmedResult.toAsset();
    const cx = worldSelection.rect.x + (offset.x + trimW / 2);
    const cy = worldSelection.rect.y + (offset.y + trimH / 2);

    const { id: _, ...layerData } = layer;
    const newLayer = LayerFactory.getNewLayer({
      ...layerData,
      src: assetUrl,
      assetId: assetId,
      vectorMasks: layerData.vectorMasks?.filter(m => !m.reserved) || [],
      name: LayerFactory.getNewLayerName(frame.layers.order.map(id => frame.layers.byId[id])),
      hostId: undefined,
      visibleShape: asLocalShape({ x: 0, y: 0, w: trimW, h: trimH }),
      bounding: { w: trimW, h: trimH },
      cx,
      cy,
      birthCenter: { cx, cy },
      scale: 1,
      rotation: 0,
      flip: { h: false, v: false },
      adjustments: { brightness: 100, contrast: 100, saturation: 100, hueRotate: 0, blur: 0 }
    });

    return { newLayer, localShape, url: assetUrl };
  }

  // ─── fragmentToExistLayer ────────────────────────────────────────────────────
  /**
   * Applies a fragment to an existing target layer (e.g. Exchange layer for peel).
   * Uses logical intersection to determine the visible portion.
   */
  function fragmentToExistLayer(
    frame: Frame,
    sourceLayer: Layer,
    targetLayer: Layer,
    selection: LocalShape | LocalPolygon
  ): { updatedLayer: Layer; localShape: LocalShape } | null {
    const localShape = isPolygon(selection)
      ? polygonToShape(geometry.polygon.frameLocalToLayerLocal(selection, frame, sourceLayer))
      : geometry.shape.frameLocalToLayerLocal(selection, frame, sourceLayer);
    const intersection = geometry.shape.intersectWithLayer(localShape, sourceLayer);
    if (!intersection) return null;

    const v = intersection.visibleShape.rect;
    const pose = geometry.transform.computeFragmentCenter(intersection.center, { x: v.x, y: v.y }, sourceLayer.rotation, sourceLayer.flip);

    const updatedLayer = {
      ...targetLayer,
      src: sourceLayer.src,
      assetId: sourceLayer.assetId,
      cx: pose.x,
      cy: pose.y,
      scale: 1,
      rotation: sourceLayer.rotation,
      flip: { ...sourceLayer.flip },
      bounding: { w: v.w, h: v.h },
      visibleShape: { ...intersection.visibleShape },
      interactive: true,
      opacity: 1,
      visible: true,
      adjustments: sourceLayer.adjustments,
      curves: sourceLayer.curves,
      levels: sourceLayer.levels,
      channelMix: sourceLayer.channelMix,
      colorBalance: sourceLayer.colorBalance,
    };

    return { updatedLayer, localShape };
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  return {
    /** Unified entry point for all fragment operations */
    fragmentToNewLayer,
    /** Physical fragment: always produces a baked PNG blob (needed for clipboard) */
    fragmentToNewLayerPhysical,
    /** Fragment to existing layer (peel exchange) */
    fragmentToExistLayer,
  };
}
