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
  Layer, Frame, asLocalShape, type Point2D, type LocalPolygon, type LocalShape,
} from '@opengpex/editor/core/types';
import { intersectPathWithPath } from '@opengpex/editor/core/geometry/poly-clip';
import { parsePathDataToRings, ringsToPathData, shapeToPoint2D, point2dToLocalPolygon } from '@opengpex/editor/core/geometry/operators/point2d';
import { layerLocalToFrameLocal } from '@opengpex/editor/core/geometry/operators/polygon';

/**
 * LayerUtils: High-frequency pure function toolset for layer operations
 * Provides general layer calculation methods independent of business logic and state management.
 */
export const LayerUtils = {
  /**
   * getCompositeKey: Generates fast-track composite key (frameId:layerId)
   * Used to achieve artboard-level isolation in the flat fast-track cache.
   */
  getCompositeKey(frameId: string, layerId: string): string {
    return `${frameId}:${layerId}`;
  },

  /**
   * mergeLayerDraft: Merges a layer with its fast-track draft
   * Used for high-performance data merging prior to rendering.
   */
  mergeLayerDraft(layer: Layer, draft?: Partial<Layer>): Layer {
    if (!draft) return layer;
    return { ...layer, ...draft };
  },

  /**
   * getMaskOrigin: Single source of truth for the layer-local origin that an
   * eraser/restore BitmapMask canvas is anchored to.
   *
   * ── Why this exists ──────────────────────────────────────────────────────────
   * A layer's content is NOT drawn at bounding-local (0,0). `painter2d`
   * (`drawLayerContent`) blits the source pixels via
   *   drawImage(src, v.x, v.y, v.w, v.h,  v.x, v.y, v.w, v.h)
   * so the content always occupies the bounding-local rect
   * `(vx, vy, vw, vh)` — where `(vx, vy) = visibleShape.rect.x/y`.
   *
   * For a zero-copy logical fragment (lasso / rect Cmd+J), `bounding` equals the
   * selection size while `visibleShape.rect.x/y` points at the selection's
   * position inside the SHARED source bitmap. With `vx >= bounding.w` the
   * bounding-local rects `(0,0,bw,bh)` and `(vx,vy,vw,vh)` are entirely
   * DISJOINT. A mask built on the (0,0) basis therefore has zero overlap with
   * the content, and `destination-in` erases the whole fragment.
   *
   * ── Contract ─────────────────────────────────────────────────────────────────
   * Mask canvas pixel `(px, py)` maps to layer-local `(origin.x + px, origin.y + py)`.
   * Both producers and consumers of a bitmap mask must use this same basis:
   *   - stamp placement            → subtract the origin (BrushOverlay stamp path)
   *   - `BitmapMask.bounds.x/y`    → equals the origin (bake + live-preview override)
   *
   * Since `BitmapMask.bounds` is consumed verbatim by both the main-thread
   * onscreen engine and the Worker composite branches,
   * encoding the origin into `bounds` keeps screen rendering and export aligned
   * without any extra offset at composite time (no double-subtraction).
   *
   * ── Zero regression ──────────────────────────────────────────────────────────
   * A regular full-layer image has `visibleShape.rect.x/y === 0` (i.e.
   * `isFragment === false`), so this returns `(0, 0)` and every call site
   * degenerates to the previous behaviour bit-for-bit.
   */
  getMaskOrigin(layer: Pick<Layer, 'visibleShape'>): { x: number; y: number } {
    const rect = layer.visibleShape?.rect;
    if (!rect) return { x: 0, y: 0 };
    return { x: rect.x || 0, y: rect.y || 0 };
  },

  /**
   * collectAssetIds: every content-addressed asset id each layer REFERENCES —
   * the layer's own pixel asset plus each bitmap mask's grayscale asset.
   * Vector masks are pure geometry and adjustment masks are pure parameters
   * (no assets), so they contribute nothing.
   *
   * Grouped by layer id; deduped WITHIN a layer, deliberately NOT across
   * layers — per-layer independence is what per-layer adjudication and
   * asset-GC decisions need (e.g. the paste-source check: a logical paste can
   * reference the originals only while EVERY id of that one layer resolves).
   */
  collectAssetIds(layers: Layer[]): Record<string, string[]> {
    const byLayer: Record<string, string[]> = {};
    for (const layer of layers) {
      const ids: string[] = [];
      if (layer.assetId && !ids.includes(layer.assetId)) ids.push(layer.assetId);
      for (const mask of layer.bitmapMasks ?? []) {
        if (mask.assetId && !ids.includes(mask.assetId)) ids.push(mask.assetId);
      }
      byLayer[layer.id] = ids;
    }
    return byLayer;
  },

  /**
   * resolveFragmentOutline: the layer's recorded CUT OUTLINE as rings, the
   * single degradation ladder every consumer of `Layer.contour` must go
   * through. `contour` is BIRTH-RIGHT METADATA of cut-lineage layers — it
   * records the selection AS DRAWN (the gesture, for Refocus / re-cut /
   * selection re-arm), never a generic shape source; layers not born from a
   * cut simply have none, and absent is the correct state for them.
   * Degradation tiers:
   *   1. the recorded `contour.rings`;
   *   2. the `visibleShape` outline (any shape type — legacy feathered
   *      logical fragments carry the tight rings as pathData; a plain
   *      physical fragment's full-bounds rect serializes to the same rings
   *      the callers' bounds fallback would produce);
   *   3. null — the caller applies its OWN terminal fallback (re-cut
   *      intersects against the full bounds; selection re-arm keeps the
   *      current selection). No consumer may re-implement tiers 1-2.
   */
  resolveFragmentOutline(layer: Layer): Point2D[][] | null {
    const recorded = layer.contour;
    if (recorded && Array.isArray(recorded.rings) && recorded.rings.length > 0) {
      return recorded.rings;
    }
    if (layer.visibleShape) {
      return shapeToPoint2D(layer.visibleShape);
    }
    return null;
  },

  /**
   * intersectContour: ct2 = S ∩ ct1 — the new cut contour is the selection
   * intersected with the source's selection extent (both in the source's
   * coordinate space), the `Layer.contour` record a fragment carries for
   * Refocus. The source's extent resolves through `resolveFragmentOutline`,
   * with the full bounds as the terminal fallback (a layer with no visible
   * shape record has no outline — its whole plane is its extent). Holes and
   * bitmap masks
   * do NOT participate — they are render facts carried by the source's
   * masks, and Refocus must re-arm the selection AS DRAWN; the subtraction
   * happens again at re-cut time through those same masks. Empty
   * intersection (selection entirely outside the source's selection extent —
   * possible over a feather band whose 50% line lies elsewhere) yields
   * undefined: there is no contour to record.
   */
  intersectContour(layer: Layer, selRings: Point2D[][]): Point2D[][] | undefined {
    const ct = LayerUtils.resolveFragmentOutline(layer)
      ?? shapeToPoint2D(asLocalShape({ x: 0, y: 0, w: layer.bounding.w, h: layer.bounding.h }, 'rect'));
    const res = intersectPathWithPath(
      ringsToPathData(selRings),
      ringsToPathData(ct),
    );
    if (!res || !res.pathData) return undefined;
    return parsePathDataToRings(res.pathData);
  },

/**
 * buildFragmentConfinement — project a fragment's cut outline into a frame
 * selection polygon ("selection convergence": after an operation lands a
 * fragment, the surviving selection should describe the TAKEN piece, not the
 * once-drawn region).
 *
 * Coordinate contract (mirrors Refocus syncToOverlay): the rings — the
 * recorded `contour` when present, else the `visibleShape` outline — live in
 * the layer-local frame the fragment's geometry fields live in, and are
 * projected through the fragment's own world matrix. Feather and AA ride the
 * fragment's edge record (`visibleShape.featherPx` / `antiAliased`): the
 * rings are the 50% contour, so re-arming with the same radius reproduces the
 * exact soft band a re-cut would take.
 *
 * Returns null when the fragment carries no outline (no contour and no
 * visibleShape) — callers keep the current selection in that case.
 */
  /**
   * computeConfinementFromLayer — project a fragment's cut outline into a
   * frame selection polygon ("selection convergence"): after an operation
   * lands a fragment, the surviving selection should describe the TAKEN
   * piece. Outlines resolve through {@link LayerUtils.resolveFragmentOutline};
   * feather/AA ride the fragment's edge record (visibleShape.featherPx /
   * antiAliased): the rings are the 50% contour, so re-arming with the same
   * radius reproduces the exact soft band a re-cut would take. Terminal
   * fallback = null (caller keeps the current selection).
   */
  computeConfinementFromLayer(
      frame: Frame,
      fragment: Layer,
    ): LocalPolygon | null {
    const vs = fragment.visibleShape as ({ featherPx?: number; antiAliased?: boolean } & LocalShape) | undefined;
    // Outline resolution goes through the shared degradation ladder
    // (contour → visibleShape path → null); the terminal fallback here is
    // "keep the current selection".
    const rings = LayerUtils.resolveFragmentOutline(fragment);
    if (!rings || rings.length === 0) return null;
    const feather = vs?.featherPx ?? 0;
    const antiAliased = vs?.antiAliased !== false;
    const localPoly = point2dToLocalPolygon(rings as never, {
      antiAliased,
      ...(feather > 0 ? { feather } : {}),
    });
    return layerLocalToFrameLocal(localPoly, fragment, frame);
  },

  /**
   * breakCutLinks: sever every cut relationship touching the target layer
   * while the layer itself SURVIVES — the rasterize counterpart of the
   * 'break-link' semantics of removeLayers. Deletion never heals, and
   * neither does rasterization: hole masks stay as content (they render at
   * their true cut line) and only the POINTERS die, so the holes stop
   * counting as mergeable fragments while Merge Back can no longer reach a
   * dangling provenance.
   *
   * The target can hold BOTH roles at once — a cut chain A→B→C makes B a
   * fragment of A and the source of C — so both directions break in one
   * call and one function guarantees "both die together", matching how the
   * merge bake terminates its participants' relationships in a single pass:
   *
   * 1. Target is a fragment (`metadata.sourceLayerId` + `assocMaskId`):
   *    its provenance pair is stripped, and the source's hole mask
   *    (`id === assocMaskId`) loses `assocLayerId` — the mask itself stays.
   *    Pure-copy provenance (`sourceLayerId` without `assocMaskId`) is
   *    stripped too: a baked product carries no cut semantics.
   * 2. Target is a cut source (other fragments reference it): each
   *    referencing fragment's provenance is stripped (the same degradation
   *    the merge bake applies to out-of-set downstream layers), because the
   *    target's baked pixels no longer honor the cut relationship. The
   *    target's own hole masks are NOT touched here — the bake bakes them
   *    into pixels and the caller clears them with the rest of the layer's
   *    masks.
   *
   * PURE: returns patches and performs no writes. The caller applies
   * `targetPatch` together with its own baked-layer patch and each
   * `otherPatches` entry through its state layer, in any order.
   */
  breakCutLinks(frame: Frame, targetId: string): {
    targetPatch: Partial<Layer>;
    otherPatches: Array<{ layerId: string; patch: Partial<Layer> }>;
  } {
    const target = frame.layers.byId[targetId];
    if (!target) return { targetPatch: {}, otherPatches: [] };

    const sourceLayerId = target.metadata?.sourceLayerId as string | undefined;
    const assocMaskId = target.metadata?.assocMaskId as string | undefined;

    const targetPatch: Partial<Layer> = {};
    const otherPatches: Array<{ layerId: string; patch: Partial<Layer> }> = [];

    // Direction 1 — target is a fragment: strip its provenance pair and
    // unlink the source's hole mask (kept as content, pointer cleared).
    if (sourceLayerId || assocMaskId) {
      targetPatch.metadata = { ...target.metadata, sourceLayerId: undefined, assocMaskId: undefined };
    }
    if (sourceLayerId && assocMaskId) {
      const source = frame.layers.byId[sourceLayerId];
      if (source?.vectorMasks?.some(m => m.id === assocMaskId && m.assocLayerId)) {
        otherPatches.push({
          layerId: sourceLayerId,
          patch: {
            vectorMasks: source.vectorMasks.map(m =>
              m.id === assocMaskId ? { ...m, assocLayerId: undefined } : m
            ),
          },
        });
      }
    }

    // Direction 2 — target is a cut source: degrade every fragment that
    // references it (cut fragments via the full pair, copy fragments via
    // sourceLayerId alone) to a plain layer with no cut lineage.
    for (const id of frame.layers.order) {
      if (id === targetId) continue;
      const fragment = frame.layers.byId[id];
      if (!fragment || fragment.metadata?.sourceLayerId !== targetId) continue;
      otherPatches.push({
        layerId: id,
        patch: { metadata: { ...fragment.metadata, sourceLayerId: undefined, assocMaskId: undefined } },
      });
    }

    return { targetPatch, otherPatches };
  }
};
