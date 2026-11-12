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
import { polygonToShape } from '@opengpex/editor/core/geometry/operators/polygon';
import { classifyRegionOverlap, type RegionOverlap } from '@opengpex/editor/core/geometry/poly-clip';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { isBoundingRing, point2dToLocalShape, shapeToPoint2D } from '@opengpex/editor/core/geometry/operators/point2d';
import { trimTransparentMargins } from '@opengpex/editor/core/engine/utils/pixel-utils';
import { LayerFactory, computeFragmentFeathering } from '../../factory';
import { LayerUtils } from '@opengpex/editor/core/layer/utils';

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
   * (physical bake) instead of cropping it logically. A logical fragment carries
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
  /**
   * resolveNature — the single gate deciding how the product fragment will
   * exist: `'physical'` (baked snapshot), `'logical'` (shared source asset
   * cropped through geometry), or `undefined` (the layer cannot produce a
   * fragment at all — group containers have no pixels; the route table maps
   * undefined to the R00 noop refusal). Physical serves the CUT carrying a
   * feather (soft edges belong to baked alpha) or the SOURCE subtracting
   * content through SOFT MASKS (bitmap mask, feathered hole) — a logical
   * fragment expresses edge softness as one shape-global radius, which
   * cannot represent per-edge falloff, and a bitmap mask is not geometry at
   * all. Everything else (clean sources, physical feathered fragments whose
   * band lives in the shared asset's alpha, bake-type sources whose
   * content is text/vector layout) cuts logically.
   */
  function resolveNature(frame: Frame, layer: Layer, feather: number): 'logical' | 'physical' | undefined {
    if (feather > 0) return 'physical';
    if ((layer.bitmapMasks ?? []).some(m => m.enabled)) return 'physical';
    if ((layer.vectorMasks ?? []).some(m => m.enabled && (m.feather ?? 0) > 0)) return 'physical';
    // Text / vector content has no croppable bitmap: any partial cut bakes.
    if (layer.type === 'text' || layer.type === 'vector') return 'physical';
    // Group containers have no pixels — nothing to cut.
    if (layer.type === 'group') return undefined;
    const box = getClipBox(frame);
    if (!box) return 'logical';
    const { shape, invertedRegular } = resolveCutShape(
      geometry.polygon.frameLocalToLayerLocal(box, frame, layer), layer, box.antiAliased,
    );
    if (invertedRegular) return 'logical';
    const fold = geometry.shape.intersectWithLayer(shape, layer);
    return !fold || (fold.featherPx ?? 0) > 0 ? 'physical' : 'logical';
  }

  /**
   * The selection's relation to the source's visible extent — the overlap
   * half of the cut context (the nature half is `resolveNature`), computed
   * here so both halves of the routing decision live in the same module.
   * Layer-local comparison (a rigid transform, so feather distances are
   * preserved). No selection counts as 'full': a whole-layer cut is exactly
   * a covering cut.
   */
  function resolveOverlap(frame: Frame, layer: Layer, feather: number): RegionOverlap {
    const box = getClipBox(frame);
    if (!box) return 'full';
    const selection = geometry.polygon.frameLocalToLayerLocal(box, frame, layer).rings;
    const region = shapeToPoint2D(
      layer.visibleShape ?? asLocalShape({ x: 0, y: 0, w: layer.bounding.w, h: layer.bounding.h }),
    );
    return classifyRegionOverlap(selection, region, feather);
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
   * This is the SHARED CORE of the two logical-fragment production sites:
   * the clip commands consume the product layer directly, while the peel
   * exchange (the logical branch of `clipToExchangeLayer`) calls it with the peel's
   * selection/feather and adapts the product onto the existing target layer.
   * A feathered selection is routed to the physical bake before reaching
   * here for the clip commands, but the peel exchange legitimately passes
   * one — the core then wraps the tight cut geometry in the canonical
   * feathered-fragment form (`computeFragmentFeathering`).
   *
   * `selection` defaults to the frame's active clip box; peel passes its
   * selection entity explicitly so the core never reads `frame` behind the
   * caller's back.
   *
   * Cut mode also returns the source hole. `linkHole` false leaves the hole
   * unlinked (a clipboard Cut: its product never enters the document, so
   * there is no fragment to link to).
   */
  async function clipToLogicalLayer(
    frame: Frame,
    layer: Layer,
    options?: {
      mode?: 'copy' | 'cut';
      linkHole?: boolean;
      selection?: LocalShape | LocalPolygon;
      feather?: number;
    }
  ): Promise<{ newLayer: Layer; holeMask?: VectorMask } | null> {
    const box = options?.selection ?? getClipBox(frame);
    if (!box) return null;
    const feather = options?.feather ?? 0;

    // The selection in the source's local frame. A polygon goes through
    // `resolveCutShape`, which additionally recovers an inverted-regular
    // (bounding-ring + inner-ring) pair as a mask flip instead of a naive
    // path; a plain shape can never be an inverted pair.
    let localShape: LocalShape;
    let invertedRegular = false;
    if (isPolygon(box)) {
      const resolved = resolveCutShape(
        geometry.polygon.frameLocalToLayerLocal(box, frame, layer), layer, box.antiAliased,
      );
      localShape = resolved.shape;
      invertedRegular = resolved.invertedRegular;
    } else {
      localShape = geometry.shape.frameLocalToLayerLocal(box, frame, layer);
    }
    const intersection = invertedRegular ? null : geometry.shape.intersectWithLayer(localShape, layer);
    if (!invertedRegular && !intersection) return null;

    let newLayer: Layer;
    // The hole (cut mode) is the EXACT region taken: the tight intersection
    // shape, captured before a feather pad reshapes the product's
    // visibleShape (the soft band is shared edge falloff, not hole territory).
    let tightVisible: LocalShape | undefined;
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
      tightVisible = { ...intersection.visibleShape };
      if (feather > 0) {
        // Canonical feathered-fragment form (see computeFragmentFeathering):
        // the tight cut geometry insets inside a symmetrically padded rect
        // that carries featherPx, because the soft band extends f beyond the
        // cut contour and an unpadded plane leaves the fade no pixels to
        // render over.
        intersection.visibleShape = computeFragmentFeathering(intersection.visibleShape, feather).visibleShape;
      }
      const v = intersection.visibleShape.rect;
      newLayer.bounding = { w: v.w, h: v.h };
      newLayer.visibleShape = { ...intersection.visibleShape };
      const pose = geometry.transform.computeFragmentCenter(intersection.center, { x: v.x, y: v.y }, layer.rotation, layer.flip);
      newLayer.cx = pose.x;
      newLayer.cy = pose.y;
      // The grade chain needs NO re-base: a logical fragment's geometry
      // fields (visibleShape, adjust-mask shapes, contour) all live in the
      // SOURCE-continued local frame — the fragment behaves as a window at
      // rect v inside that frame, and the renderer re-bases them crop-locally
      // itself (SceneAssembler subtracts visibleShape.rect.x/y; the pose
      // above pairs with the same convention via computeFragmentCenter).
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
    newLayer.nature = 'logical';
    if (frame.latestClipTool) {
      newLayer.metadata = { ...newLayer.metadata, clipTool: frame.latestClipTool };
    }
    // The cut contour: S ∩ ct1, where the resolved cut shape carries S (the
    // inner shape for an inverted-regular selection). A logical fragment has
    // no baked edge, so its contour falloff is always hard (feather 0 for the
    // clip commands — a feathered selection routes physical; the peel
    // exchange keeps its soft edge on `visibleShape.featherPx`, which is not
    // contour territory).
    //
    // Coordinate contract: contour rings live in the layer-local frame where
    // the fragment's OTHER geometry fields live — for a logical fragment that
    // is the SOURCE-continued frame (visibleShape.rect keeps its source
    // coords v; the pose pairs with it via computeFragmentCenter), so the
    // rings carry through UNCHANGED in source coordinates. Consumers (Refocus
    // syncToOverlay, migrateFragmentContour, the peel commit union) project
    // them through the fragment's own matrix, which is built for exactly this
    // convention; re-basing them by −v here would shift every consumer's
    // read-back by −v (real-device finding 2026-11-12: Refocus after a peel
    // landed off by the selection offset). A PHYSICAL product is the opposite
    // case: its plane is its own (fresh asset), so its rings re-base onto the
    // trimmed plane (see clipToPhysicalLayer).
    const logicalContour = LayerUtils.intersectContour(layer, shapeToPoint2D(localShape));
    if (logicalContour && logicalContour.length > 0) {
      newLayer.contour = { rings: logicalContour };
    }

    // ═══ Cut mode: the hole + bidirectional pointers ═══
    if (options?.mode === 'cut') {
      const maskId = `mask-hole-${newLayer.id}`;
      // The hole is exactly the region the fragment took (the folded
      // intersection's tight shape, or the inverted selection's inner shape),
      // so hole and fragment are complementary.
      const holeShape: LocalShape = intersection
        ? { ...(tightVisible ?? intersection.visibleShape) }
        : localShape;
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
   * Used for external clipboard export, for the physical clip operation and
   * for the peel exchange on hosts the logical fold cannot describe: all
   * three need a real bitmap of exactly the selected pixels, trimmed to its
   * opaque content.
   */
  async function clipToPhysicalLayer(
    frame: Frame,
    layer: Layer,
    options?: { feather?: number; clampPlane?: boolean }
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

    // vs2 = (S ∩ vs1) + feather pad — for a product that ENTERS THE DOCUMENT, the
    // plane is the selection clamped to the source's image extent, expanded
    // by the feather margin (pad = ceil(f+1) ≥ f + AA half-texel): content
    // the source lacks (erased areas, transparency) stays in the plane as
    // transparency instead of pulling it inward, and the feather band's
    // faint outermost texels are kept whole. The external clipboard
    // projection opts out — another application receives the actual content,
    // tightly cropped.
    let trimResult: Awaited<ReturnType<typeof trimTransparentMargins>>;
    if (options?.clampPlane) {
      // (S ∩ vs1) extent, ring level: the source's true extent resolves
      // through intersectContour's tiers (recorded `contour` rings when the
      // source is itself a fragment; a path `visibleShape`; otherwise its
      // full-bounds plane) and the lens AABB is taken from the ring
      // intersection. A rect-level intersection against `visibleShape` would
      // grossly overestimate for a fragment source — a feathered fragment's
      // plane is its padded trim box, far wider than the lens a shifted
      // recut actually spans, and forcing the plane to that rect keeps whole
      // transparent margins of it (recut finding 2026-11-12: the recut
      // fragment's height never converged). For original layers the tier
      // fallback resolves their full-bounds plane, whose ring intersection
      // bbox equals the rect intersection; the rect path below remains only
      // as the fallback for an EMPTY ring intersection (the selection sits
      // over a pure feather band whose 50% lines do not meet).
      let srcExtent: { x: number; y: number; w: number; h: number } | null = null;
      const lensRings = LayerUtils.intersectContour(layer, localPoly.rings);
      if (lensRings && lensRings.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const ring of lensRings) {
          for (const p of ring) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
          }
        }
        srcExtent = geometry.shape.layerLocalToFrameLocal(
          asLocalShape({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, 'rect'),
          layer,
          frame,
        ).rect;
      } else {
        const vsFrameRect = geometry.shape.layerLocalToFrameLocal(
          layer.visibleShape ?? asLocalShape({ x: 0, y: 0, w: layer.bounding.w, h: layer.bounding.h }, 'rect'),
          layer,
          frame,
        ).rect;
        srcExtent = geometry.space.getRectIntersection(selRect, vsFrameRect) ?? selRect;
      }
      const clampExtent = {
        x: srcExtent.x - pad - frameLocalShape.rect.x,
        y: srcExtent.y - pad - frameLocalShape.rect.y,
        w: srcExtent.w + 2 * pad,
        h: srcExtent.h + 2 * pad,
      };
      trimResult = await trimTransparentMargins(composited, clampExtent);
    } else {
      trimResult = await trimTransparentMargins(composited);
    }
    if (!trimResult) return null; // Entirely transparent — no content in selection

    const { image: trimmedImage, offset } = trimResult;
    const trimW = trimmedImage.bounds.w;
    const trimH = trimmedImage.bounds.h;

    // The cut contour (S ∩ ct1, in source-local rings), re-based onto the
    // trimmed plane.
    const contourRings = LayerUtils.intersectContour(layer, localPoly.rings);
    const contourRingsRebased = contourRings
      ? geometry.polygon.translatePolygon(
          geometry.polygon.layerLocalToFrameLocal(
            geometry.point2d.point2dToLocalPolygon(contourRings),
            layer,
            frame,
          ),
          -(frameLocalShape.rect.x + offset.x),
          -(frameLocalShape.rect.y + offset.y),
        ).rings
      : undefined;
    const { assetId, url: assetUrl } = await assets.storeBundle(trimmedImage);

    // Warm the source-bitmap cache BEFORE the fragment enters the document:
    // the decode is async, and a cold cache makes the fragment's first frames
    // draw empty (the creation flicker, device finding 2026-11-13). The same
    // warm-up bakeToAsset performs; loadBitmap is cache-first, so on a warm
    // cache this is instant.
    // Light-touch: some test harnesses stub the pixel service without the
    // image namespace — the warm-up must never be the thing that fails.
    await pixels.image?.loadBitmap(assetUrl)?.catch(() => undefined);
    const cx = worldSelection.rect.x + (offset.x + trimW / 2);
    const cy = worldSelection.rect.y + (offset.y + trimH / 2);

    // The product is a plain bitmap: strip the vector payload so a text /
    // vector source yields an image layer, not a half-updated original type.
    const { id: _id, textData: _t, markerData: _m, strokeData: _sd, strokes: _st, penData: _p, penStyle: _ps, ...layerData } = layer as Layer & Record<string, unknown>;
    // A baked product is a NEW layer: it must not inherit the source's own cut link.
    const newLayer = LayerFactory.getNewLayer({
      ...layerData,
      type: 'image',
      src: assetUrl,
      assetId: assetId,
      vectorMasks: [],
      bitmapMasks: [],
      name: LayerFactory.getNewLayerName(frame.layers.order.map(id => frame.layers.byId[id])),
      hostId: undefined,
      // visibleShape records the cut honestly per the nature split:
      // the plane is a trim box, and `featherPx`/`antiAliased` carry THIS
      // cut's edge falloff and AA as a RECORD (the renderer takes the alpha
      // route for physical layers and ignores them — the real edge lives in
      // the baked alpha).
      visibleShape: {
        ...asLocalShape({ x: 0, y: 0, w: trimW, h: trimH }),
        featherPx: feather,
        antiAliased: box.antiAliased !== false,
      },
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
      nature: 'physical',
      ...(contourRingsRebased && contourRingsRebased.length > 0 ? { contour: { rings: contourRingsRebased } } : {}),
    });

    return { newLayer, localShape, holeShape, url: assetUrl };
  }

  // ─── clipToExchangeLayer ────────────────────────────────────────────────────
  /**
   * Applies a fragment to an existing target layer (the Exchange layer of a
   * peel). Both forms delegate to the SAME production primitives the clip
   * commands use — this function is only form choice plus target mapping:
   *
   *   logical   the target shares the source asset and shows
   *             (selection ∩ the source's visible region) through geometry,
   *             built by the shared core `clipToLogicalLayer` (mode 'copy':
   *             the peel digs its own session hole from `localShape`, so the
   *             core emits none). Exact only while the source's masks fold
   *             into hard geometry.
   *   physical  the target owns a baked bitmap: the source composited through
   *             ALL its masks plus the selection (with its feather), built by
   *             `clipToPhysicalLayer` (clampPlane: the exchange enters the
   *             document, so its plane follows the model formula). Taken when
   *             the fold cannot describe the piece — an enabled bitmap mask,
   *             or holes with feathers — and as the fallback whenever the
   *             logical intersection comes back empty, since a degraded fold
   *             is indistinguishable from a real miss at this level.
   *
   * The selection feather alone does NOT force the physical form here (it
   * does for the clip commands): a feathered peel of a clean source stays
   * logical and renders its soft edge from `visibleShape.featherPx`.
   *
   * `localShape` is the raw selection in the source's local frame either way;
   * the caller digs the host hole from it, so the hole is identical for both
   * forms. `physical` names the form taken. Returns null only when the
   * selection holds no pixel of the source.
   *
   * The physical form reads the selection from `frame` (the bake composites
   * the frame's selection entity), so `selection` must be that same entity.
   */
  async function clipToExchangeLayer(
    frame: Frame,
    sourceLayer: Layer,
    targetLayer: Layer,
    selection: LocalShape | LocalPolygon
  ): Promise<{ updatedLayer: Layer; localShape: LocalShape; physical: boolean } | null> {
    const feather = isPolygon(selection) ? (selection.feather ?? 0) : 0;
    // The raw selection in the source's local frame — the host-hole source
    // (the caller digs it from this, deliberately NOT the padded form).
    const localShape = isPolygon(selection)
      ? polygonToShape(geometry.polygon.frameLocalToLayerLocal(selection, frame, sourceLayer))
      : geometry.shape.frameLocalToLayerLocal(selection, frame, sourceLayer);

    // ── Physical form (the nature gate and the logical-miss fallback) ──
    // Bake the selected piece and hand the target its own bitmap, trimmed to
    // its content exactly like a Layer via Cut product (the same bake
    // primitive). Axis-aligned in the frame: rotation / flip / grade chain of
    // the source are all burnt into the pixels, so the target carries none.
    // Caveat inherited from the trim: when the transparent area inside the
    // selection is LOPSIDED (an eraser rim on one side, the selection
    // overhanging the layer), the trimmed box centre is not the selection
    // centre, and the drag handler's "plane centre = selection centre" rule
    // shifts the fragment on the first pointer move.
    const physicalForm = async (): Promise<{ updatedLayer: Layer; localShape: LocalShape; physical: boolean } | null> => {
      // The exchange always renders at full opacity with normal blending (the
      // logical form sets the same), so the bake must not burn the source's
      // own opacity or blend mode into the pixels.
      const participant: Layer = { ...sourceLayer, opacity: 1, blendMode: 'source-over' };
      const baked = await clipToPhysicalLayer(frame, participant, { feather, clampPlane: true });
      if (!baked) return null;

      const product = baked.newLayer;
      const updatedLayer: Layer = {
        ...targetLayer,
        src: product.src,
        assetId: product.assetId,
        cx: product.cx,
        cy: product.cy,
        scale: 1,
        rotation: 0,
        flip: { h: false, v: false },
        bounding: { ...product.bounding },
        visibleShape: product.visibleShape,
        // The plane was rewritten, so the target's previous contour (it may
        // itself be an older fragment) is stale in this new coordinate space:
        // ALWAYS overwrite, never merge — an absent product contour clears the
        // field and the exchange degrades to the plane rect.
        contour: product.contour,
        // Declared explicitly (the fail-safe default would land here anyway):
        // the edge lives in this bake's alpha, so SceneAssembler must take the
        // crop-only path and never re-soften with the recorded feather.
        nature: 'physical',
        interactive: true,
        opacity: 1,
        visible: true,
        adjustMasks: undefined,
      };
      return { updatedLayer, localShape: baked.localShape, physical: true };
    };

    if (isPolygon(selection) && resolveNature(frame, sourceLayer, 0) === 'physical') {
      return physicalForm();
    }

    // ── Logical form: shared source asset, narrowed visible shape ──
    // The core computes the fragment (intersection, canonical feather form,
    // pose, contour, adjust-mask rebase); the mapping below adapts its
    // product onto the EXISTING target layer — the exchange keeps its
    // identity (id, name, role) and picks up only the fragment's geometry
    // and declaration.
    const result = await clipToLogicalLayer(frame, sourceLayer, { mode: 'copy', selection, feather });
    if (result) {
      const p = result.newLayer;
      const updatedLayer: Layer = {
        ...targetLayer,
        src: sourceLayer.src,
        assetId: sourceLayer.assetId,
        cx: p.cx,
        cy: p.cy,
        scale: 1,
        rotation: sourceLayer.rotation,
        flip: { ...sourceLayer.flip },
        bounding: { ...p.bounding },
        visibleShape: { ...(p.visibleShape as LocalShape) },
        // The declaration is LOAD-BEARING here, not bookkeeping: every
        // consumer keys on `nature` with strict equality and treats anything
        // unmarked as physical (fail-safe). SceneAssembler routes a physical
        // layer to the crop-only UV path — it shows the visibleShape RECT of
        // the shared source and ignores the path geometry and `featherPx` —
        // so an undeclared logical exchange renders as a hard rectangle of
        // the selection's bounding box with no feather, no matter what shape
        // was drawn. Declaring logical routes the exchange to the implicit
        // shape-mask path, where the pathData clips and the feather band
        // renders (same split as the clip commands' products).
        nature: 'logical',
        // The 50% cut line as pure geometry, in this exchange's plane
        // coordinates — the shared core already re-based the rings. The
        // previous contour (the target may itself be an older fragment) is
        // stale in this new coordinate space: ALWAYS overwrite, never merge —
        // an absent core contour clears the field and the exchange degrades
        // to the plane rect.
        contour: p.contour,
        interactive: true,
        opacity: 1,
        visible: true,
        // The grade chain follows the pixels: the core re-based the shapes by
        // the plane offset (the padded rect origin when feathered).
        adjustMasks: p.adjustMasks,
        // The core's mask set is authoritative for the form it took (a tight
        // crop carries none — the edges live in geometry alone; an inverted
        // regular window carries the inverted selection mask). It also
        // replaces any stale masks the target carried from an earlier form.
        vectorMasks: p.vectorMasks ?? [],
        bitmapMasks: p.bitmapMasks ?? [],
        // The exchange is born (as this fragment) at this very pose.
        birthCenter: p.birthCenter,
        // Lineage from the core's copy-mode product: where the piece came from
        // and which tool cut it (the target's own metadata — e.g. a session
        // hole pointer the caller writes afterwards — is preserved as the base).
        metadata: {
          ...(targetLayer.metadata ?? {}),
          ...(p.metadata?.clipTool !== undefined ? { clipTool: p.metadata.clipTool } : {}),
          ...(p.metadata?.sourceLayerId !== undefined ? { sourceLayerId: p.metadata.sourceLayerId } : {}),
        },
      };
      return { updatedLayer, localShape, physical: false };
    }

    // The logical intersection came back empty: a degraded fold is not
    // distinguishable from a real miss here, so fall back to the bake — but
    // only a polygon can reach the physical bake chain (it reads the
    // selection from the frame's entity).
    if (!isPolygon(selection)) return null;
    return physicalForm();
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  return {
    /** Whether a partial clip of a raster-backed layer must bake (physical) */
    resolveOverlap,
    resolveNature,
    /** Unified entry point for all fragment operations */
    clipToLogicalLayer,
    /** Physical fragment: always produces a baked PNG blob (needed for clipboard) */
    clipToPhysicalLayer,
    /** Fragment to existing layer (peel exchange) */
    clipToExchangeLayer,
  };
}
