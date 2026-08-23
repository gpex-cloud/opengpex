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

export type FragmentStrategy = 'logical' | 'physical' | 'vectorMask';

/** Describes how to punch a hole in the source layer during cut operations. */
export interface SourceHoleDescriptor {
  /** VectorMask approach: shape + inversion + feather (logical/vectorMask strategies) */
  mask?: { shape: LocalShape; inverted: boolean; feather: number };
  /** Metadata to patch onto the source layer (e.g. clipTool tracking) */
  metadata?: Record<string, unknown>;
}

/**
 * FragmentResult: Unified result from all fragment operations.
 *
 * Provides enough information for callers to:
 * - Add the fragment layer (newLayer)
 * - Punch a hole in the source layer for cut operations (sourceHole)
 */
export interface FragmentResult {
  newLayer: Layer;
  localShape: LocalShape;
  invertedRegular: boolean;
  strategy: FragmentStrategy;
  /** Asset URL (only present for physical strategy) */
  url?: string;
  /** Hole descriptor for cut mode — callers apply this to the source layer */
  sourceHole?: SourceHoleDescriptor;
}

/**
 * ResolvedShape: Result of resolving a clip box polygon into a layer-local shape.
 */
interface ResolvedShape {
  shape: LocalShape;
  invertedRegular: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Strategy Resolution
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
): ResolvedShape {
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

/**
 * resolveFragmentStrategy: Determines which fragment execution path to use.
 *
 * Priority rules:
 *   1. feather > 0 || invertedRegular       → vectorMask
 *   2. non-rect selection ∩ non-rect layer  → physical
 *   3. everything else                      → logical
 */
export function resolveFragmentStrategy(
  feather: number,
  invertedRegular: boolean,
  localShape: LocalShape,
  layer: Layer
): FragmentStrategy {
  // 1. feather / invertedRegular → always vectorMask
  if (feather > 0 || invertedRegular) return 'vectorMask';

  // 2. non-rect selection ∩ non-rect layer (includes circle∩path) → physical (unsolvable geometrically)
  const layerVisType = layer.visibleShape?.type;
  if (layerVisType && layerVisType !== 'rect' && localShape.type !== 'rect') {
    return 'physical';
  }

  // 3. everything else → logical (rect∩rect, rect∩path, circle∩rect, path∩rect)
  return 'logical';
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

  // ─── fragmentByVectorMask ────────────────────────────────────────────────────
  /**
   * VectorMask path: Duplicates the full layer and applies a VectorMask.
   * Used for feathered selections and invertedRegular cases where geometric
   * fragmentation would introduce anti-aliasing seams.
   */
  function fragmentByVectorMask(
    frame: Frame,
    layer: Layer,
    nameType: string,
    localShape: LocalShape,
    invertedRegular: boolean,
    feather: number
  ): FragmentResult {
    const layersArray = frame.layers.order.map(id => frame.layers.byId[id]);
    const newName = LayerFactory.getNewLayerName(layersArray, nameType);

    // New layers must never inherit lock/interactive/structural state from the source
    const { id: _id, hostId: _pid, role: _role, locked: _locked, interactive: _inter, ...layerData } = layer;
    const newLayer = LayerFactory.getNewLayer({
      ...layerData,
      name: newName,
      vectorMasks: [],
    });

    // If invertedRegular, the shape is the inner rect/ellipse — to reveal
    // "everything except that shape" we use inverted=true (pixel-perfect boundary).
    // Normal case: reveal only the shape area → inverted=false.
    newLayer.vectorMasks = [LayerFactory.getNewVectorMask(localShape, invertedRegular, feather)];

    // Record source clip tool so refocus can restore the correct tool slot
    if (frame.latestClipTool) {
      newLayer.metadata = { ...newLayer.metadata, clipTool: frame.latestClipTool };
    }

    return { newLayer, localShape, invertedRegular, strategy: 'vectorMask' };
  }

  // ─── fragmentByLogical ───────────────────────────────────────────────────────
  /**
   * Logical path: Geometric crop — creates a new layer that references the same
   * source image with a narrowed visibleShape. Zero overhead, lossless.
   *
   * NOTE: This function is only called when resolveFragmentStrategy returns 'logical'.
   * The strategy resolver already filters out path∩path and circle-clipped+AA-off cases,
   * so no fallback guards are needed here.
   */
  function fragmentByLogical(
    frame: Frame,
    layer: Layer,
    nameType: string
  ): { newLayer: Layer; localShape: LocalShape } | null {
    const box = getClipBox(frame);
    if (!box) return null;
    const localShape = polygonToShape(geometry.polygon.frameLocalToLayerLocal(box, frame, layer));
    const intersection = geometry.shape.intersectWithLayer(localShape, layer);

    if (!intersection) return null;

    const { id: _oldId, ...layerData } = layer;
    const newLayer = LayerFactory.getNewLayer({
      ...layerData,
      vectorMasks: layerData.vectorMasks?.filter(m => !m.reserved) || [],
      name: LayerFactory.getNewLayerName(frame.layers.order.map(id => frame.layers.byId[id]), nameType),
      hostId: undefined
    });

    const v = intersection.visibleShape.rect;
    newLayer.bounding = { w: v.w, h: v.h };
    newLayer.visibleShape = { ...intersection.visibleShape };
    // Correctly compute (cx, cy) accounting for layer orientation (rotation/flip).
    const pose = geometry.transform.computeFragmentCenter(intersection.center, { x: v.x, y: v.y }, layer.rotation, layer.flip);
    newLayer.cx = pose.x;
    newLayer.cy = pose.y;
    newLayer.birthCenter = { cx: newLayer.cx, cy: newLayer.cy };

    // Mark as logical (non-physical) layer: src references the original image,
    // visibleShape provides the clip mask.
    newLayer.metadata = { ...newLayer.metadata, physicalPixels: false };

    // Record the source clip tool so refocus can restore the correct tool slot
    if (frame.latestClipTool) {
      newLayer.metadata = { ...newLayer.metadata, clipTool: frame.latestClipTool };
    }

    return { newLayer, localShape };
  }

  // ─── fragmentByPhysical ──────────────────────────────────────────────────────
  /**
   * Physical path: Composites the layer content within the selection, trims
   * transparent pixels, and registers the result as a new asset.
   * Used when geometric intersection is impossible or imprecise.
   */
  async function fragmentByPhysical(
    frame: Frame,
    layer: Layer,
    nameType: string
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
      name: LayerFactory.getNewLayerName(frame.layers.order.map(id => frame.layers.byId[id]), nameType),
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
    // Correctly compute (cx, cy) accounting for source layer orientation (rotation/flip).
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
      // Propagate non-destructive adjustment state so the fragment renders
      // identically to the source layer.
      adjustments: sourceLayer.adjustments,
      curves: sourceLayer.curves,
      levels: sourceLayer.levels,
      channelMix: sourceLayer.channelMix,
      colorBalance: sourceLayer.colorBalance,
    };

    return { updatedLayer, localShape };
  }

  // ─── fragmentToLayer (Unified Entry Point) ───────────────────────────────────
  /**
   * fragmentToLayer: Unified entry point for all fragment operations.
   *
   * Resolves the active selection, determines the optimal fragment strategy
   * (vectorMask / logical / physical), executes it, and returns a unified result.
   *
   * Callers use this for both Copy and Cut:
   * - Copy: just add result.newLayer
   * - Cut: add result.newLayer + punch hole using result.localShape/invertedRegular
   */
  async function fragmentToLayer(
    frame: Frame,
    layer: Layer,
    nameType: string,
    options?: { feather?: number; mode?: 'copy' | 'cut' }
  ): Promise<FragmentResult | null> {
    const box = getClipBox(frame);
    if (!box) return null;

    const feather = options?.feather ?? 0;
    const { shape: localShape, invertedRegular } = resolveLocalShape(box, frame, layer, geometry);

    const strategy = resolveFragmentStrategy(feather, invertedRegular, localShape, layer);

    let baseResult: FragmentResult | null = null;

    switch (strategy) {
      case 'vectorMask':
        baseResult = fragmentByVectorMask(frame, layer, nameType, localShape, invertedRegular, feather);
        break;

      case 'logical': {
        const result = fragmentByLogical(frame, layer, nameType);
        if (result) {
          baseResult = { ...result, invertedRegular, strategy: 'logical' };
        } else {
          // Safety fallback: if logical unexpectedly returns null (edge case not caught
          // by strategy prediction), fall through to physical.
          const physResult = await fragmentByPhysical(frame, layer, nameType);
          if (!physResult) return null;
          baseResult = { ...physResult, invertedRegular, strategy: 'physical' };
        }
        break;
      }

      case 'physical': {
        const result = await fragmentByPhysical(frame, layer, nameType);
        if (!result) return null;
        baseResult = { ...result, invertedRegular, strategy: 'physical' };
        break;
      }
    }

    if (!baseResult) return null;

    // ═══ Cut mode: generate sourceHole descriptor ═══
    if (options?.mode === 'cut') {
      // invertedRegular=true → the shape is the inner rect/ellipse.
      //   To hide "everything except that shape" we use inverted=false
      //   (= "show only that shape" = hide everything else).
      // invertedRegular=false → normal: inverted=true = "hide the selection area".
      const maskInverted = !baseResult.invertedRegular;

      baseResult.sourceHole = {
        mask: {
          shape: baseResult.localShape,
          inverted: maskInverted,
          feather,
        },
        metadata: frame.latestClipTool
          ? { clipTool: frame.latestClipTool }
          : undefined,
      };
    }

    return baseResult;
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  return {
    /** Unified entry point for all fragment operations */
    fragmentToLayer,
    /** Physical fragment: always produces a baked PNG blob (needed for clipboard) */
    fragmentToLayerPhysical: fragmentByPhysical,
    /** Fragment to existing layer (peel exchange) */
    fragmentToExistLayer,
  };
}
