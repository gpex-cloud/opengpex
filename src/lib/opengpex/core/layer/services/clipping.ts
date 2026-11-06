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
  GeometryService, PixelService, AssetService,
  Frame, Layer, VectorMask, LocalShape, LocalPolygon,
  asLocalShape, asLocalRect, isPolygon
} from '@opengpex/editor/core/types';
import { polygonToShape, translatePolygon } from '@opengpex/editor/core/geometry/operators/polygon';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { isBoundingRing, point2dToLocalShape } from '@opengpex/editor/core/geometry/operators/point2d';
import { trimTransparentMargins } from '@opengpex/editor/core/engine/utils/pixel-utils';
import { shapeToPathData } from '@opengpex/editor/core/geometry/operators/shape';
import { AA_MARGIN, LayerFactory } from '../factory';


// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// Shape Resolution
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// Fragment Operations Factory
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * createFragmentOperations: Factory that creates all fragment-related operations
 * with access to the required service dependencies.
 */
export function createFragmentOperations(
  geometry: GeometryService,
  pixels: PixelService,
  assets: AssetService
) {

  // ─── clipToLogicalLayer (Unified Entry Point) ────────────────────────────────
  /**
   * clipToLogicalLayer: Unified entry point for all fragment operations.
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
  async function clipToLogicalLayer(
    frame: Frame,
    layer: Layer,
    options?: { feather?: number; mode?: 'copy' | 'cut' }
  ): Promise<{ newLayer: Layer; holeMask?: VectorMask } | null> {
    const box = getClipBox(frame);
    if (!box) return null;

    const feather = options?.feather ?? 0;

    // ── Resolve the cut shape: selection (frame coords) → layer-local shape ──
    // Special handling for "inverted regular" polygons: when a rect/ellipse is
    // inverted (Cmd+Shift+I), it becomes a polygon with
    // [canvasBoundaryRing, originalShapeRing]. Naively converting this to a
    // `type:'path'` shape makes the path renderer anti-alias the inner ring
    // boundary — a visible seam against the pixel-perfect rect/ellipse mask
    // from the prior cut. Detection: 2-ring polygon where ring[0] ≈ layer
    // boundary and ring[1] is recognizable as a rect (4 axis-aligned points)
    // or ellipse (64-point fit). When detected, the inner ring becomes the cut
    // shape and `invertedRegular` flips the mask direction — same visual
    // region, pixel-perfect boundary.
    const layerPoly = geometry.polygon.frameLocalToLayerLocal(box, frame, layer);
    let detectedInner: LocalShape | undefined;
    if (layerPoly.rings.length === 2) {
      const outerRing = layerPoly.rings[0];
      const innerRing = layerPoly.rings[1];
      if (isBoundingRing(outerRing, layer.bounding.w, layer.bounding.h)) {
        detectedInner = point2dToLocalShape([innerRing], box.antiAliased ?? true) ?? undefined;
      }
    }
    const { shape: localShape, invertedRegular } = detectedInner
      ? { shape: detectedInner, invertedRegular: true }
      : { shape: polygonToShape(layerPoly), invertedRegular: false };

    let newLayer: Layer;

    // ── Path decision: logical first, vectorMask fallback ──────────────────────
    // Logical (tight crop) is viable for both hard and feathered cuts:
    // feathering never changes the boolean topology, so the hard contour bbox is
    // always computable. The only whole-layer fallbacks left are `invertedRegular`
    // (annular: outer ring = canvas boundary, no tight bbox exists) and the degrade
    // cases inside intersectWithLayer (bitmap mask / divergent per-mask feather).
    const intersection = (!invertedRegular)
      ? geometry.shape.intersectWithLayer(localShape, layer)
      : null;

    if (intersection) {
      // ═══ Logical path: geometric crop — same source image, narrowed visibleShape ═══
      const { id: _oldId, ...layerData } = layer;
      newLayer = LayerFactory.getNewLayer({
        ...layerData,
        // The effective visibleShape from intersectWithLayer already folded EVERY
        // enabled hole/clip mask into the geometry (getEffectiveVisibleShape →
        // difference/intersect); this logical path only runs when that fold did NOT
        // degrade, so every vectorMask is already baked in. Inheriting them again
        // would re-subtract the holes a second time — in the SOURCE's coordinate
        // frame, not the re-centred fragment's — turning the fragment transparent.
        vectorMasks: [],
        bitmapMasks: LayerFactory.cleanInheritedMasks(layerData.bitmapMasks),
        name: LayerFactory.getNewLayerName(frame.layers.order.map(id => frame.layers.byId[id])),
        hostId: undefined
      });

      // Effective feather = max(new-cut feather, folded source-mask feather). The
      // dominant case (plain layer, feathered cut) has folded featherPx=0, so this is
      // just the new cut's feather. Padding + the implicit shape mask below.
      const v = intersection.visibleShape.rect;
      const effFeather = Math.max(feather, intersection.featherPx ?? 0);
      const pad = effFeather > 0 ? Math.ceil(effFeather + AA_MARGIN) : 0;

      if (pad > 0) {
        // ── Feathered fragment: pad the crop bbox outward by `pad` on all sides so
        // the soft edge has real source pixels to fade against, and carry the TIGHT
        // geometry as pathData + `featherPx`. SceneAssembler renders this as an
        // implicit (feathered) vmask; symmetric padding keeps the tight region's
        // world centre fixed, so `intersection.center` is still the anchor and the
        // visibleOffset is simply the padded rect's origin.
        const tightPath = shapeToPathData(intersection.visibleShape);
        const paddedRect = asLocalRect({ x: v.x - pad, y: v.y - pad, w: v.w + 2 * pad, h: v.h + 2 * pad });
        newLayer.bounding = { w: paddedRect.w, h: paddedRect.h };
        newLayer.visibleShape = {
          type: 'path',
          rect: paddedRect,
          antiAliased: intersection.visibleShape.antiAliased,
          pathData: tightPath,
          featherPx: effFeather,
          __brand: 'local',
        } as unknown as LocalShape;
        const pose = geometry.transform.computeFragmentCenter(intersection.center, { x: paddedRect.x, y: paddedRect.y }, layer.rotation, layer.flip);
        newLayer.cx = pose.x;
        newLayer.cy = pose.y;
      } else {
        // ── Hard fragment (feather=0): tight crop, value-for-value unchanged. ──
        newLayer.bounding = { w: v.w, h: v.h };
        newLayer.visibleShape = { ...intersection.visibleShape };
        const pose = geometry.transform.computeFragmentCenter(intersection.center, { x: v.x, y: v.y }, layer.rotation, layer.flip);
        newLayer.cx = pose.x;
        newLayer.cy = pose.y;
      }
      newLayer.birthCenter = { cx: newLayer.cx, cy: newLayer.cy };
      newLayer.metadata = { ...newLayer.metadata, physicalPixels: false };

      if (frame.latestClipTool) {
        newLayer.metadata = { ...newLayer.metadata, clipTool: frame.latestClipTool };
      }

    } else {
      // ═══ Whole-layer fallback: full layer + vmask for visibility control ═══
      // This branch serves ONLY the two cases that have no
      // tight bbox to crop to — `invertedRegular` (annular: outer ring is the canvas
      // boundary) and the intersectWithLayer degrade cases (bitmap mask present, or
      // ≥2 distinct per-mask feathers). Plain feathered cuts do not land here —
      // they take the logical (padded) path above.
      const { id: _id, hostId: _pid, role: _role, locked: _locked, interactive: _inter, ...layerData } = layer;
      newLayer = LayerFactory.getNewLayer({
        ...layerData,
        name: LayerFactory.getNewLayerName(frame.layers.order.map(id => frame.layers.byId[id])),
        vectorMasks: [],
        bitmapMasks: LayerFactory.cleanInheritedMasks(layerData.bitmapMasks),
      });

      // invertedRegular → inverted=true → "show everything except shape" (pixel-perfect)
      // normal → inverted=false → "show only the shape area"
      newLayer.vectorMasks = [
        ...LayerFactory.cleanInheritedMasks(layerData.vectorMasks),
        LayerFactory.getNewVectorMask(localShape, { inverted: invertedRegular, feather }),
      ];

      if (frame.latestClipTool) {
        newLayer.metadata = { ...newLayer.metadata, clipTool: frame.latestClipTool };
      }

    }

    // ═══ Cut mode: generate the hole mask + bidirectional pointers ═══
    if (options?.mode === 'cut') {
      const maskId = `mask-hole-${newLayer.id}`;

      // The hole punched into the source layer MUST be the *real* geometry
      // the fragment actually took — the TIGHT intersection (selection ∩ (A − prior
      // holes)), NOT the fragment's padded visibleShape. For a hard cut the two are
      // identical (pad=0); for a feathered cut the fragment's visibleShape is grown
      // by `pad` to hold the soft edge, but the hole must stay tight so hole+fragment
      // are complementary (the hole carries the same `feather` below, so heal — delete
      // the fragment — precisely reverses this cut, no punch-through / no leftover
      // void). When the logical path degraded to a vectorMask fallback (`intersection`
      // is null), fall back to the raw selection `localShape` (legacy behavior).
      const holeShape: LocalShape = intersection
        ? { ...intersection.visibleShape }
        : localShape;

      // The hole is a fully-formed VectorMask (via the standard factory) —
      // callers append it to the source layer's vectorMasks verbatim.
      const holeMask = LayerFactory.getNewVectorMask(holeShape, {
        maskId,
        assocLayerId: newLayer.id,
        inverted: !invertedRegular,
        feather,
      });

      newLayer.metadata = {
        ...newLayer.metadata,
        sourceLayerId: layer.id,
        assocMaskId: maskId,
      };
      return { newLayer, holeMask };
    }

    // ═══ Copy mode (or any non-cut): write sourceLayerId for lineage tracking ═══
    if (options?.mode === 'copy' || !options?.mode) {
      newLayer.metadata = {
        ...newLayer.metadata,
        sourceLayerId: layer.id,
      };
    }

    return { newLayer };
  }

  // ─── clipToPhysicalLayer ──────────────────────────────────────────────
  /**
   * Physical path: Composites the layer content within the selection, trims
   * transparent pixels, and registers the result as a new asset.
   * Used exclusively for clipboard export (always needs a real PNG blob).
   */
  async function clipToPhysicalLayer(
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
    const composited = await pixels.render.compositeLayers([layer], frame, frameLocalShape);
    const trimResult = await trimTransparentMargins(composited);
    if (!trimResult) return null; // Entirely transparent — no content in selection

    const { image: trimmedImage, offset } = trimResult;
    const trimW = trimmedImage.bounds.w;
    const trimH = trimmedImage.bounds.h;
    const { assetId, url: assetUrl } = await assets.storeBundle(trimmedImage);
    const cx = worldSelection.rect.x + (offset.x + trimW / 2);
    const cy = worldSelection.rect.y + (offset.y + trimH / 2);

    const { id: _, ...layerData } = layer;
    const newLayer = LayerFactory.getNewLayer({
      ...layerData,
      src: assetUrl,
      assetId: assetId,
      vectorMasks: [],
      bitmapMasks: [],
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
      adjustMasks: undefined,
      // Physical-layer declaration (see services/baking.ts): this export always
      // bakes a fresh asset the layer owns.
      metadata: { ...(layerData.metadata ?? {}), physicalPixels: true },
    });

    return { newLayer, localShape, url: assetUrl };
  }

  // ─── clipToExistLayer ────────────────────────────────────────────────────
  /**
   * Applies a fragment to an existing target layer (e.g. Exchange layer for peel).
   * Uses logical intersection to determine the visible portion.
   */
  function clipToExistLayer(
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
      // The grade chain follows the pixels. A confined entry's shape is in the
      // SOURCE layer's local frame; the target shows the intersection sub-rect
      // (origin at v.x/v.y), so the rings re-base by that offset.
      adjustMasks: sourceLayer.adjustMasks?.map((m) =>
        m.shape ? { ...m, shape: translatePolygon(m.shape, -v.x, -v.y) } : m,
      ),
    };

    return { updatedLayer, localShape };
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  return {
    /** Unified entry point for all fragment operations */
    clipToLogicalLayer,
    /** Physical fragment: always produces a baked PNG blob (needed for clipboard) */
    clipToPhysicalLayer,
    /** Fragment to existing layer (peel exchange) */
    clipToExistLayer,
  };
}
