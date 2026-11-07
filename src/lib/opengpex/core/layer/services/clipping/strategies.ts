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
  asLocalShape, isPolygon
} from '@opengpex/editor/core/types';
import { polygonToShape, translatePolygon } from '@opengpex/editor/core/geometry/operators/polygon';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { isBoundingRing, point2dToLocalShape } from '@opengpex/editor/core/geometry/operators/point2d';
import { trimTransparentMargins } from '@opengpex/editor/core/engine/utils/pixel-utils';
import { LayerFactory, computeFragmentFeathering } from '../../factory';

/**
 * createFragmentOperations: Factory that creates all fragment-related operations
 * with access to the required service dependencies.
 */
export function createFragmentOperations(
  geometry: GeometryService,
  pixels: PixelService,
  assets: AssetService
) {

  /**
   * Detect an "inverted regular" selection: after Invert Selection a rect /
   * ellipse becomes a 2-ring polygon [layer-boundary ring, original shape
   * ring]. Converting that naively to a path shape would anti-alias the inner
   * ring against the pixel-perfect rect / ellipse mask of an earlier cut, so
   * the inner ring is recovered as the cut shape and the mask direction is
   * flipped instead — same region, pixel-perfect boundary.
   */
  function resolveCutShape(layerPoly: LocalPolygon, layer: Layer, antiAliased: boolean | undefined):
    { shape: LocalShape; invertedRegular: boolean } {
    if (layerPoly.rings.length === 2 && isBoundingRing(layerPoly.rings[0], layer.bounding.w, layer.bounding.h)) {
      const inner = point2dToLocalShape([layerPoly.rings[1]], antiAliased ?? true);
      if (inner) return { shape: inner, invertedRegular: true };
    }
    return { shape: polygonToShape(layerPoly), invertedRegular: false };
  }

  /**
   * Whether a partial clip of a raster-backed layer must bake its product
   * (rasterize) instead of cropping it logically. A logical fragment carries
   * hard geometry only; it is exact when its whole edge is the selection
   * contour. Anything that would put a soft or raster edge on it bakes:
   *   - a feathered selection (the soft edge belongs to the baked alpha),
   *   - an enabled bitmap mask on the source (raster alpha cannot be folded
   *     into geometry),
   *   - source holes the fold cannot express as hard geometry (a feathered
   *     hole: folding its feather would soften the fragment's OUTER edge too;
   *     ≥2 distinct feathers degrade the fold entirely).
   * An inverted regular selection is cut as a full-bounds window and never
   * folds, so only the first two conditions apply to it.
   */
  function shouldRoutePhysical(frame: Frame, layer: Layer, feather: number): boolean {
    if (feather > 0) return true;
    if ((layer.bitmapMasks ?? []).some(m => m.enabled)) return true;
    const box = getClipBox(frame);
    if (!box) return false;
    const { shape, invertedRegular } = resolveCutShape(
      geometry.polygon.frameLocalToLayerLocal(box, frame, layer), layer, box.antiAliased,
    );
    if (invertedRegular) return false;
    const fold = geometry.shape.intersectWithLayer(shape, layer);
    return !fold || (fold.featherPx ?? 0) > 0;
  }

  // ─── clipToLogicalLayer ──────────────────────────────────────────────────────
  /**
   * Logical fragment: the product shares the source asset and narrows its
   * visible shape. Routing guarantees a hard cut on a source whose masks fold
   * into hard geometry (see shouldRoutePhysical), so the fragment is either a
   * tight crop to (selection ∩ the source's visible region) or, for an
   * inverted regular selection that has no tight box, a full-bounds window
   * showing the selection through an inverted mask.
   *
   * Cut mode also returns the source hole. `linkHole` false leaves the hole
   * unlinked (a clipboard Cut: its product never enters the document, so
   * there is no fragment to link to).
   */
  async function clipToLogicalLayer(
    frame: Frame,
    layer: Layer,
    options?: { mode?: 'copy' | 'cut'; linkHole?: boolean }
  ): Promise<{ newLayer: Layer; holeMask?: VectorMask } | null> {
    const box = getClipBox(frame);
    if (!box) return null;

    const { shape: localShape, invertedRegular } = resolveCutShape(
      geometry.polygon.frameLocalToLayerLocal(box, frame, layer), layer, box.antiAliased,
    );
    const intersection = invertedRegular ? null : geometry.shape.intersectWithLayer(localShape, layer);
    if (!invertedRegular && !intersection) return null;

    let newLayer: Layer;
    if (intersection) {
      // ═══ Tight crop: same source image, narrowed visibleShape ═══
      const { id: _oldId, ...layerData } = layer;
      newLayer = LayerFactory.getNewLayer({
        ...layerData,
        // The intersection already folded every enabled hole / clip mask into
        // the geometry; inheriting them again would subtract the holes a
        // second time — in the SOURCE's coordinate frame, not the re-centred
        // fragment's — turning the fragment transparent.
        vectorMasks: [],
        bitmapMasks: [],
        name: LayerFactory.getNewLayerName(frame.layers.order.map(id => frame.layers.byId[id])),
        hostId: undefined
      });
      const v = intersection.visibleShape.rect;
      newLayer.bounding = { w: v.w, h: v.h };
      newLayer.visibleShape = { ...intersection.visibleShape };
      const pose = geometry.transform.computeFragmentCenter(intersection.center, { x: v.x, y: v.y }, layer.rotation, layer.flip);
      newLayer.cx = pose.x;
      newLayer.cy = pose.y;
    } else {
      // ═══ Inverted regular selection: full-bounds window ═══
      // The outer ring is the layer boundary, so no box smaller than the
      // layer holds the selection: keep the full bounds and show the
      // selection through an inverted mask (pixel-perfect inner contour).
      const { id: _id, hostId: _pid, role: _role, locked: _locked, interactive: _inter, ...layerData } = layer;
      newLayer = LayerFactory.getNewLayer({
        ...layerData,
        name: LayerFactory.getNewLayerName(frame.layers.order.map(id => frame.layers.byId[id])),
        vectorMasks: [
          ...LayerFactory.cleanInheritedMasks(layerData.vectorMasks),
          LayerFactory.getNewVectorMask(localShape, { inverted: true }),
        ],
        bitmapMasks: [],
      });
    }
    newLayer.birthCenter = { cx: newLayer.cx, cy: newLayer.cy };
    // Logical either way: the fragment renders the SOURCE asset and shows its
    // own piece through geometry or a mask, owning no asset of its own.
    newLayer.metadata = { ...newLayer.metadata, physicalPixels: false };
    if (frame.latestClipTool) {
      newLayer.metadata = { ...newLayer.metadata, clipTool: frame.latestClipTool };
    }

    // ═══ Cut mode: the hole + bidirectional pointers ═══
    if (options?.mode === 'cut') {
      const maskId = `mask-hole-${newLayer.id}`;
      // The hole is exactly the region the fragment took (the folded
      // intersection, or the inverted selection's inner shape), so hole and
      // fragment are complementary.
      const holeShape: LocalShape = intersection ? { ...intersection.visibleShape } : localShape;
      const linkHole = options.linkHole ?? true;
      const holeMask = LayerFactory.getNewVectorMask(holeShape, {
        maskId,
        ...(linkHole ? { assocLayerId: newLayer.id } : {}),
        inverted: !invertedRegular,
      });
      newLayer.metadata = {
        ...newLayer.metadata,
        sourceLayerId: layer.id,
        ...(linkHole ? { assocMaskId: maskId } : {}),
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
   * Physical path: composites the layer content WITHIN THE SELECTION SHAPE,
   * trims transparent pixels, and registers the result as a new asset.
   *
   * The composite roi is an AABB — it sizes the synthetic canvas and shifts
   * coordinates, it does NOT cut to the selection polygon. The shape cut and
   * the feather bake are done by the GPU mask pipeline instead: the caller's
   * layer is cloned with the selection attached as a non-inverted vector mask
   * (carrying the feather), so SceneAssembler's vmask pass masks the render
   * and readback only ever sees selected pixels. `trimTransparentMargins`
   * then tightens the product to the visible content.
   *
   * Used for external clipboard export and for the rasterize clip operation:
   * both need a real PNG blob of exactly the selected pixels.
   */
  async function clipToPhysicalLayer(
    frame: Frame,
    layer: Layer,
    options?: { feather?: number }
  ): Promise<{ newLayer: Layer; localShape: LocalShape; holeShape: LocalShape; url: string } | null> {
    const box = getClipBox(frame);
    if (!box) return null;
    const feather = options?.feather ?? 0;
    const localPoly = geometry.polygon.frameLocalToLayerLocal(box, frame, layer);
    const localShape = polygonToShape(localPoly);
    // No geometric emptiness pre-check: a bitmap mask or divergent hole
    // feathers make the fold degrade (null) even when content is selected.
    // The router already rejected a selection that misses the layer; an
    // empty composite is caught by the trim below.
    // The source hole = the selection itself, with the cut's feather. Masks
    // combine by multiplication, so the fragment (baked THROUGH the source's
    // own masks plus the selection: base × m_sel) and this hole (multiplying
    // the source by 1 − m_sel) are exactly complementary over any underlying
    // mask state — earlier holes included, feathered or not. A geometric
    // fold is neither needed nor desirable: polygon clipping the contour
    // would shift the edge a few pixels against the fragment's raw-shape
    // mask, and a binary difference cannot express partial ownership anyway.
    const holeShape: LocalShape = localShape;

    // Frame-local selection rect as composite ROI, padded so the feather band
    // (which extends beyond the polygon edge) and AA stay inside the canvas.
    const selRect = polygonToShape(box).rect;
    const pad = feather > 0 ? Math.ceil(feather + 1) : 1;
    const frameLocalShape = asLocalShape({
      x: selRect.x - pad,
      y: selRect.y - pad,
      w: selRect.w + 2 * pad,
      h: selRect.h + 2 * pad,
    }, 'rect');
    const worldSelection = geometry.shape.localToWorldShape(frameLocalShape, frame);

    // ── Composite + trim in memory (no intermediate asset registration) ────
    // Layer clone carrying the selection as a keep-inside mask with feather:
    // the GPU vmask pass bakes shape cut + soft edge into the readback.
    const participant: Layer = {
      ...layer,
      vectorMasks: [
        ...(layer.vectorMasks ?? []),
        LayerFactory.getNewVectorMask(localShape, { inverted: false, feather }),
      ],
    };
    const composited = await pixels.render.compositeLayers([participant], frame, frameLocalShape);
    const trimResult = await trimTransparentMargins(composited);
    if (!trimResult) return null; // Entirely transparent — no content in selection

    const { image: trimmedImage, offset } = trimResult;
    const trimW = trimmedImage.bounds.w;
    const trimH = trimmedImage.bounds.h;
    const { assetId, url: assetUrl } = await assets.storeBundle(trimmedImage);
    const cx = worldSelection.rect.x + (offset.x + trimW / 2);
    const cy = worldSelection.rect.y + (offset.y + trimH / 2);

    // The product is a plain bitmap: strip the vector payload so a text /
    // vector source yields an image layer, not a half-updated original type.
    const { id: _id, textData: _t, markerData: _m, strokeData: _sd, strokes: _st, penData: _p, penStyle: _ps, ...layerData } = layer as Layer & Record<string, unknown>;
    // A rasterized product is a NEW layer: it must not inherit the source's own cut link.
    const newLayer = LayerFactory.getNewLayer({
      ...layerData,
      type: 'image',
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
      metadata: {
        ...(layerData.metadata ?? {}),
        physicalPixels: true,
      },
    });

    return { newLayer, localShape, holeShape, url: assetUrl };
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

    // Feather decree (selection-feather upgrade): a feathered selection peels
    // a SOFT-EDGED fragment — the intersection shape carries the selection's
    // radius so the exchange renders its edge with the same smoothstep band
    // the host hole (inverted mask, same radius) attenuates by. Fragment m ⊕
    // hole 1−m is the same complementary split a feathered cut bakes.
    //
    // CANONICAL FEATHERED-FRAGMENT FORM (same invariant patchEdgeFeatherRepad
    // maintains): the tight cut geometry stays as pathData, inset inside a
    // symmetrically PADDED rect (pad = ceil(f) + AA margin) that carries
    // featherPx, and `bounding` == padded-rect size. The pad is load-bearing:
    // the soft band extends f beyond the cut contour, and an unpadded (tight)
    // layer plane gives the fade no pixels to render over — the edges read as
    // hard cuts (real-device finding, lasso peel 2026-11-10). The pose is
    // re-derived around the padded rect origin so the content stays put.
    const feather = isPolygon(selection) ? (selection.feather ?? 0) : 0;
    if (feather > 0) {
      intersection.visibleShape = computeFragmentFeathering(intersection.visibleShape, feather).visibleShape;
    }

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
      // (origin at v.x/v.y — the padded rect when feathered), so the rings
      // re-base by that offset.
      adjustMasks: sourceLayer.adjustMasks?.map((m) =>
        m.shape ? { ...m, shape: translatePolygon(m.shape, -v.x, -v.y) } : m,
      ),
    };

    return { updatedLayer, localShape };
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  return {
    /** Whether a partial clip of a raster-backed layer must bake (rasterize) */
    shouldRoutePhysical,
    /** Unified entry point for all fragment operations */
    clipToLogicalLayer,
    /** Physical fragment: always produces a baked PNG blob (needed for clipboard) */
    clipToPhysicalLayer,
    /** Fragment to existing layer (peel exchange) */
    clipToExistLayer,
  };
}
