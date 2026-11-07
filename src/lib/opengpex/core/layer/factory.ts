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

import { shapeToPathData } from '@opengpex/editor/core/geometry/operators/shape';
import { computeFragmentCenter, getOrientationMatrix } from '@opengpex/editor/core/geometry/operators/transform';
import { LAYER_ROLE_CONFIGS, HOST_LAYER_ORDER } from '@opengpex/editor/core/helpers/config';
import {
  Layer, Frame, VectorMask, BitmapMask, LayerRole,
  LocalShape, LocalRect, asLocalShape, asLocalRect
} from '@opengpex/editor/core/types';

/** Type-safe role configuration index helper */
const roleConfigMap = LAYER_ROLE_CONFIGS as Record<string, { label: string; order: number; follow: boolean } | undefined>;

export const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * LayerFactory: Core business domain logic
 * Responsible for layer production, structural completion, sorting, cascading updates, and rendering pipeline definition.
 */
export const LayerFactory = {
  TRANSPARENT_PIXEL,

  // =================================================================================
  // 1. Templates & Prototypes
  // =================================================================================

  /**
   * getNewFrame: Artboard production factory (formerly createFrame)
   * Standardizes the initial structure and default state of the artboard.
   */
  getNewFrame(patch: Partial<Frame>): Frame {
    const id = patch.id || `f-${Date.now().toString(36)}`;

    // NO `bitDepth` / `colorSpace` defaults here. Colour and depth are
    // per-ASSET truth (`StoredAsset.colorIdentity`), resolved by `SceneAssembler`
    // from `assets.get(layer.assetId)`; a frame-level default was a second source
    // that silently overrode a 16-bit/P3 import with 8-bit sRGB.
    return {
      id,
      name: 'New Project',
      canvas: { w: 0, h: 0 },
      dpi: 72,
      rotation: 0,
      layers: { byId: {}, order: [] },
      camera: { x: 0, y: 0, k: 1 },
      confinement: null,
      canvasClipBox: asLocalShape({ x: 0, y: 0, w: 0, h: 0 }),
      latestClipTool: 'rect',
      ...patch
    } as Frame;
  },

  /**
   * getNewLayer: Layer production factory (formerly createLayer)
   * Completes the ID and all default values, returning a complete layer instance.
   */
  getNewLayer(patch: Partial<Layer> = {}): Layer {
    const id = patch.id || `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    const layer = {
      ...this.getBlank(),
      id,
      name: 'New Layer',
      type: 'image',
      cx: 0,
      cy: 0,
      scale: 1,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      role: 'host',
      interactive: true,
      flip: { h: false, v: false },
      bounding: { w: 0, h: 0 },
      ...patch
    } as Layer;

    // 💡 Follows design principle: visibleShape always has meaning. If not specified, defaults to match bounding
    if (layer.visibleShape && layer.visibleShape.rect.w === 0 && layer.visibleShape.rect.h === 0 && layer.bounding.w > 0) {
      layer.visibleShape = asLocalShape({ x: 0, y: 0, w: layer.bounding.w, h: layer.bounding.h });
    }

    return layer;
  },

  /**
   * getNewGroup: Group layer production factory.
   * Creates a group layer with no pixel data, used purely for organizational grouping in the UI.
   * Group layers are skipped by the rendering pipeline (type:'group' has no bitmap).
   */
  getNewGroup(patch: Partial<Layer> = {}): Layer {
    const id = patch.id || `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    return {
      id,
      name: patch.name || 'Group',
      type: 'group',
      src: TRANSPARENT_PIXEL,
      assetId: 'asset-transparent-pixel',
      cx: 0,
      cy: 0,
      scale: 1,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      interactive: false,       // Groups are not hit-testable on canvas
      flip: { h: false, v: false },
      bounding: { w: 0, h: 0 },
      vectorMasks: [],
      bitmapMasks: [],
      collapsed: false,
      ...patch,
    } as Layer;
  },

  /**
   * Fresh adjustment-mask id (time-prefixed base36 + random suffix, the same
   * collision discipline as layer/frame ids — one slider gesture may create
   * several masks within one millisecond).
   */
  newAdjustMaskId(): string {
    return `amask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  },

  /**
   * getNewVectorMask: Creates a standardized vector mask object.
   * @param shape - Mask shape descriptor (local coordinate system)
   * @param options.maskId - Custom deterministic mask id (e.g. `mask-hole-${layerId}`)
   * @param options.assocLayerId - Associated fragment layer id for cut-link tracking
   * @param options.inverted - Whether to invert the mask (default false)
   * @param options.feather - Feather radius in px (default 0)
   */
  getNewVectorMask(shape: LocalShape, options?: { maskId?: string; assocLayerId?: string; inverted?: boolean; feather?: number }): VectorMask {
    const mask: VectorMask = {
      id: options?.maskId || `mask-${shape.type}-${Date.now()}`,
      shape: { ...shape } as LocalShape,
      inverted: options?.inverted ?? false,
      feather: options?.feather ?? 0,
      enabled: true
    };
    if (options?.assocLayerId) {
      mask.assocLayerId = options.assocLayerId;
    }
    return mask;
  },

  /**
   * getNewBitmapMask: Creates a standardized bitmap mask object.
   *
   * `hard` thresholds the mask alpha at 0.5 in the GPU sampler ("pencil
   * eraser"); omitted = soft. See `BitmapMask.hard`.
   *
   * `inverted` selects the record's FAMILY (see `BitmapMask.inverted`):
   * omitted = erase family (alpha into the combine product); `true` = restore
   * family (`1 − α` into the combine max — the restore eraser's records).
   */
  getNewBitmapMask(src: string, assetId: string, bounds: LocalRect, hard?: boolean, inverted?: boolean): BitmapMask {
    return {
      id: `bmask-${Date.now()}`,
      src,
      assetId,
      bounds,
      inverted: inverted === true,
      enabled: true,
      feather: 0,
      ...(hard ? { hard: true } : {})
    };
  },

  /**
   * cleanInheritedMasks: Sanitizes masks (VectorMask or BitmapMask) when deriving or duplicating layers.
   *
   * 1. Filters out reserved masks.
   * 2. Strips `assocLayerId` from hole masks so that derived/duplicate layers do not mistakenly
   *    claim ownership of cut fragments (which belong to the original source layer).
   * 3. Assigns fresh unique IDs to inherited masks to avoid cross-layer mask ID collisions.
   */
  cleanInheritedMasks<T extends VectorMask | BitmapMask>(masks?: T[]): T[] {
    if (!masks || masks.length === 0) return [];
    return masks
      .filter(m => !('reserved' in m && m.reserved))
      .map(m => {
        // VectorMask must have shape (LocalShape), while BitmapMask has bounds/assetId/src
        const isBitmap = !('shape' in m) || 'assetId' in m || 'bounds' in m;
        const prefix = isBitmap ? 'bmask' : 'mask';
        const cleanId = `${prefix}-inherited-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

        if ('assocLayerId' in m && m.assocLayerId) {
          const { assocLayerId: _, ...cleanMask } = m;
          return {
            ...cleanMask,
            id: cleanId,
          } as unknown as T;
        }

        return {
          ...m,
          id: cleanId,
        };
      });
  },

  /**
   * getBlank: Returns a standardized "empty" layer patch. Invisible, non-interactive, no asset.
   * Per-tool payloads are cleared too: role clones are built via `{...hostLayer, ...getBlank()}`,
   * and without these the clone would silently inherit penData/strokes/markerData/textData.
   */
  getBlank(): Partial<Layer> {
    return {
      src: TRANSPARENT_PIXEL,
      assetId: 'asset-transparent-pixel',
      visible: false,
      interactive: false,
      vectorMasks: [],
      bitmapMasks: [],
      visibleShape: { type: 'rect', rect: { x: 0, y: 0, w: 0, h: 0 }, __brand: 'local' } as LocalShape,
      penData: undefined,
      strokes: undefined,
      strokeData: undefined,
      markerData: undefined,
      textData: undefined,
    };
  },

  /**
   * getNewLayerName: Smart naming engine, automatically handling increment logic like "Copy 2".
   */
  getNewLayerName(layers: Array<{ name: string }>, baseName: string = 'Layer'): string {
    const existingNames = layers.map(l => l.name);
    if (!existingNames.includes(baseName)) return baseName;

    const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escapedBase}\\s+(\\d+)$`);
    let maxNumber = 1;

    for (const name of existingNames) {
      const match = name.match(pattern);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNumber) maxNumber = num;
      }
    }
    return `${baseName} ${maxNumber + 1}`;
  },


  // =================================================================================
  // 2. Structural Orchestration
  // =================================================================================

  /**
   * expandLayers: Core structural completion, automatically completing Triplet sub-layers based on role configuration.
   */
  expandLayers(layers: Layer[]): Layer[] {
    const result: Layer[] = [];

    layers.forEach(layer => {
      result.push(layer);
      if (layer.hostId) return;

      const hasChildren = layers.some(l => l.hostId === layer.id);
      if (hasChildren) return;

      Object.entries(LAYER_ROLE_CONFIGS).forEach(([role, _config]) => {
        result.push({
          ...layer,
          ...this.getBlank(),
          id: `${layer.id}_${role}`,
          name: layer.name,
          role: role as LayerRole,
          hostId: layer.id,
          metadata: undefined, // Sub-layers must NOT inherit host metadata (sourceLayerId, assocMaskId, etc.)
        });
      });
    });

    return this.sortLayers(result);
  },

  /**
   * sortLayers: Physical layer sorting engine (Stable Sort by Order & Host Index).
   */
  sortLayers(layers: Layer[]): Layer[] {
    const hostOrderMap = new Map<string, number>();
    layers.filter(l => !l.hostId).forEach((l, i) => hostOrderMap.set(l.id, i));

    return [...layers].sort((a, b) => {
      const orderA = a.role ? roleConfigMap[a.role]?.order ?? HOST_LAYER_ORDER : HOST_LAYER_ORDER;
      const orderB = b.role ? roleConfigMap[b.role]?.order ?? HOST_LAYER_ORDER : HOST_LAYER_ORDER;

      if (orderA !== orderB) return orderA - orderB;

      const hostIdA = a.hostId || a.id;
      const hostIdB = b.hostId || b.id;
      return (hostOrderMap.get(hostIdA) ?? 0) - (hostOrderMap.get(hostIdB) ?? 0);
    });
  },


  // =================================================================================
  // 3. Domain Relationship
  // =================================================================================

  /**
   * getTriplet: Identifies the peel triplet (Host/Exchange/Frags) a layer
   * belongs to.
   *
   * Pure STRUCTURE query — it deliberately reports nothing about session
   * state. "Where is the peel session in its lifecycle" is declared by
   * `frame.drafts['peel']` (see the ClipOverlay plugin's commands/session.ts);
   * the old pixel sniffing here (`src !== TRANSPARENT_PIXEL`) was retired
   * because one stale read of it could roll back a committed peel and
   * destroy a permanent hole.
   *
   * `frags` lists ALL temporary stamp sub-layers in frame z-order (multiple
   * stamps accumulate across repeated Cmd+Alt drags within one peel session),
   * so consumers never re-implement the host/role filter sweep.
   */
  getTriplet(layer: Layer, layers: Layer[]) {
    const isHost = !layer.hostId || layer.role === 'host';
    const hostId = isHost ? layer.id : layer.hostId;

    const host = layers.find(l => l.id === hostId);
    if (!host) return null;

    const exchange = layers.find(l => l.hostId === hostId && l.role === 'exchange');
    if (!exchange) return null;

    const frags = layers.filter(l => l.hostId === hostId && l.role === 'frag');

    return { host, exchange, frags };
  },


  // =================================================================================
  // 4. Cascading
  // =================================================================================

  /**
   * getLayerCascadePatches: Computes cascading update patches.
   * When a layer undergoes geometric changes, synchronously computes follow-up patches for all its child layers based on Follow configuration.
   */
  getLayerCascadePatches(
    layers: Layer[],
    layerId: string,
    patch: Partial<Layer>
  ): Record<string, Partial<Layer>> {
    const patches: Record<string, Partial<Layer>> = { [layerId]: patch };

    const geoProps = ['cx', 'cy', 'rotation'] as const;
    const hasGeoUpdate = geoProps.some(p => p in patch);

    if (hasGeoUpdate) {
      layers.forEach(l => {
        if (l.hostId === layerId) {
          const config = l.role ? roleConfigMap[l.role] : undefined;
          if (config?.follow) {
            const syncPatch: Partial<Layer> = {};
            geoProps.forEach(p => {
              if (p in patch) (syncPatch as Record<string, unknown>)[p] = patch[p];
            });
            patches[l.id] = syncPatch;
          }
        }
      });
    }

    return patches;
  },


  // =================================================================================
  // 5. Query & Validation
  // =================================================================================

  /**
   * getHostLayers: Gets the list of host layers (excluding all child layers).
   * Host layer = top-level layer with empty parentId, which is the user-visible logical layer unit.
   */
  getHostLayers(layers: Layer[]): Layer[] {
    return layers.filter(l => !l.hostId);
  },

  /**
   * collectDescendants: BFS collects root IDs plus all their descendants from a flat parent-child list.
   * Generic utility for both layer and frame tree traversal.
   */
  collectDescendants(rootIds: string[], items: { id: string; hostId?: string | null }[]): Set<string> {
    const result = new Set<string>(rootIds);
    let prev: number;
    do {
      prev = result.size;
      for (const item of items) {
        if (item.hostId && result.has(item.hostId)) result.add(item.id);
      }
    } while (result.size !== prev);
    return result;
  },

  /**
   * canLayerBeActivated: Determines if the layer can be activated (selected) by the user.
   */
  canLayerBeActivated(layer: Layer): boolean {
    if (!layer.hostId) return true;
    if (layer.role && layer.role in LAYER_ROLE_CONFIGS) return true;
    return false;
  },

  /**
   * getInsertIndexAbove: Returns the index in frame.layers.order to insert a layer
   * directly above `targetLayerId` (skipping past all child sublayers of targetLayerId,
   * or above the highest child if targetLayerId is a group).
   */
  getInsertIndexAbove(frame: Frame, targetLayerId?: string | null): number | undefined {
    if (!targetLayerId) return undefined;
    const order = frame.layers.order;
    const targetIdx = order.indexOf(targetLayerId);
    if (targetIdx < 0) return undefined;

    const targetLayer = frame.layers.byId[targetLayerId];
    if (targetLayer?.type === 'group') {
      // Find the highest child belonging to this group via single reverse scan (O(N), 0 allocations)
      let topChildIdx = targetIdx;
      for (let i = order.length - 1; i > targetIdx; i--) {
        if (frame.layers.byId[order[i]]?.groupId === targetLayerId) {
          topChildIdx = i;
          break;
        }
      }
      let insertAt = topChildIdx + 1;
      const topId = order[topChildIdx];
      while (insertAt < order.length && frame.layers.byId[order[insertAt]]?.hostId === topId) {
        insertAt++;
      }
      return insertAt;
    }

    let insertAt = targetIdx + 1;
    while (insertAt < order.length && frame.layers.byId[order[insertAt]]?.hostId === targetLayerId) {
      insertAt++;
    }
    return insertAt;
  },

  /**
   * resolveActiveHostLayer: the host layer the currently active layer belongs to
   * — the layer a freshly placed layer lands directly on top of (Photoshop-style
   * "insert above the selected layer"). If the active layer is a triplet
   * sub-layer / mask attachment (carries a `hostId`), resolves up to its host so
   * the new layer is never wedged inside a triplet. Returns null when there is no
   * selection (callers then fall back to appending on top of the stack).
   */
  resolveActiveHostLayer(frame: Frame): Layer | null {
    const activeId = frame.activeLayerId;
    if (!activeId) return null;
    const layer = frame.layers.byId[activeId];
    if (!layer) return null;
    if (layer.hostId) return frame.layers.byId[layer.hostId] ?? null;
    return layer;
  },

  /**
   * resolveHostAbove: the host layer sitting directly ABOVE an insertion slot,
   * i.e. the layer that will end up right on top of a layer inserted at `insertAt`.
   * Resolves a triplet sub-layer (hostId) up to its host. Returns null when the
   * slot is at the top of the stack or is undefined (no reference → push to top).
   */
  resolveHostAbove(frame: Frame, insertAt: number | undefined): Layer | null {
    if (typeof insertAt !== 'number') return null;
    const order = frame.layers.order;
    if (insertAt >= order.length) return null;
    const l = frame.layers.byId[order[insertAt]];
    if (!l) return null;
    return l.hostId ? (frame.layers.byId[l.hostId] ?? null) : l;
  },

  // =================================================================================
  // 7. Layer Edge Identity
  // =================================================================================

  /**
   * resolveLayerEdgeType: which physical carrier holds this layer's EDGE.
   * Feather-agnostic — it answers "where does the edge live", and every
   * edge-affecting edit (feather today, outline tools tomorrow) dispatches
   * on the answer:
   *
   *   - `'geometry'` — a LOGICAL fragment: no (enabled) vectorMasks, a
   *     `visibleShape` that actually clips a SHARED source asset (a `path`
   *     with `pathData`, a carried `featherPx`, or a rect strictly inside the
   *     content box), AND the layer DECLARES itself logical
   *     (`metadata.physicalPixels === false`). The edge lives in the geometry;
   *     the hard-cut-away pixels still exist in the source, so geometric
   *     edits (outward pad) are lossless.
   *   - `'vmask'`    — any layer with enabled vectorMasks: the edge is the
   *     mask boundary.
   *   - `'bitmap'`   — everything else (baked products, imports, plain photo
   *     layers): the edge is the asset's own alpha.
   *
   * The declaration gate is strict-equality and fail-safe: tight geometry
   * ALONE never earns `'geometry'`. A baked physical layer carrying a tight
   * path (peel products after the outline rebuild) has nothing outside its
   * alpha, so routing it to a geometric outward edit would fade into empty
   * pixels — anything unmarked is treated physical. A full-bounds rect clips
   * nothing and is `'bitmap'` regardless.
   */
  resolveLayerEdgeType(layer: Layer): 'geometry' | 'vmask' | 'bitmap' {
    if (layer.vectorMasks?.some((m) => m.enabled !== false)) return 'vmask';
    const vs = layer.visibleShape;
    if (!vs) return 'bitmap';
    const typed = vs as { featherPx?: number; pathData?: string };
    const isLogical = layer.metadata?.physicalPixels === false;
    if (vs.type === 'path' && typed.pathData) return isLogical ? 'geometry' : 'bitmap';
    if ((typed.featherPx ?? 0) > 0) return isLogical ? 'geometry' : 'bitmap';
    if (vs.type === 'rect') {
      const r = vs.rect;
      const b = layer.bounding;
      const fullBounds = r.x <= 0 && r.y <= 0 && r.w >= b.w && r.h >= b.h;
      return fullBounds ? 'bitmap' : (isLogical ? 'geometry' : 'bitmap');
    }
    return 'bitmap';
  },

  /**
   * getEdgeFeatherValue: the CURRENT effective edge-feather radius of a
   * layer, read from whichever carrier its edge type routes to — the single
   * UI slider displays this. The value does not live in one field:
   *   - geometry → `visibleShape.featherPx`;
   *   - vmask    → the first enabled mask's `feather`;
   *   - bitmap   → the sum of `edgeFeather` over every ENABLED adjustment
   *                mask's basic arm (the alphaFeather filters are post-chain
   *                and additive, so the effective radius is their total).
   */
  getEdgeFeatherValue(layer: Layer): number {
    switch (this.resolveLayerEdgeType(layer)) {
      case 'geometry':
        return ((layer.visibleShape as { featherPx?: number } | undefined)?.featherPx ?? 0);
      case 'vmask': {
        const m = layer.vectorMasks?.find((k) => k.enabled !== false);
        return m?.feather ?? 0;
      }
      default: {
        let total = 0;
        for (const m of layer.adjustMasks ?? []) {
          if (m.enabled) total += m.grade.adjustments?.edgeFeather ?? 0;
        }
        return total;
      }
    }
  },


  // =================================================================================
  // 8. Edge Feather re-pad (the `'geometry'` edge-type edit — see
  // resolveLayerEdgeType / getEdgeFeatherValue above for routing & reads)
  // =================================================================================

  /**
 * patchEdgeFeatherRepad — the `'geometry'` edge-type feather edit as a PURE data
 * transform. Returns the full layer patch to apply (or `null` for a no-op).
 *
 * The fragment's visibleShape is the TIGHT cut geometry (`pathData`, in source-
 * asset pixel coords) inset inside a symmetrically PADDED rect (`rect`, carrying
 * `featherPx`); SceneAssembler renders it as an implicit feathered vmask
 * (`buildVectorMaskDesc` crops by `rect` and normalises the path by the rect
 * origin — the invariant that `bounding` == padded-rect size is load-bearing).
 * Re-feathering therefore: insets the current rect by the OLD pad to recover the
 * tight geometry, re-outsets by the NEW pad (`ceil(r + AA_MARGIN)`, the same
 * rule `clipToLogicalLayer`'s feathered branch uses), and rewrites
 * `visibleShape` + `bounding` as one consistent patch. `pathData` is carried
 * verbatim (still the same tight geometry, still source-asset coords); a hard
 * rect fragment (pad was 0, no pathData) is serialised to pathData here — the
 * exact data shape a feathered cut of the same geometry would have produced.
 *
 * POSE: symmetric padding keeps the padded rect's local centre (= the tight
 * region's centre) fixed, and the layer's (cx, cy) IS that centre's world
 * anchor (`computeFragmentCenter` inverted/re-applied around the rect origin
 * change below) — so the pose is re-derived, not left stale, and stays correct
 * under rotation/flip.
 */
patchEdgeFeatherRepad(
  layer: Pick<Layer, 'bounding' | 'visibleShape' | 'cx' | 'cy' | 'rotation' | 'flip'>,
  radius: number,
): {
  visibleShape: LocalShape;
  bounding: { w: number; h: number };
  cx: number;
  cy: number;
  birthCenter: { cx: number; cy: number };
} | null {
  const vs = layer.visibleShape as {
    type: string;
    rect: { x: number; y: number; w: number; h: number };
    antiAliased?: boolean;
    pathData?: string;
    featherPx?: number;
  } | undefined;
  if (!vs) return null;

  const curFeather = vs.featherPx ?? 0;
  const pad0 = curFeather > 0 ? Math.ceil(curFeather + AA_MARGIN) : 0;
  const pad1 = radius > 0 ? Math.ceil(radius + AA_MARGIN) : 0;
  if (curFeather === radius && pad0 === pad1) return null;

  // Tight geometry = current rect inset by the current symmetric pad, then
  // re-outset at the new radius through the canonical-form kernel. The input
  // keeps the shape's REAL type/pathData (a 'rect' fragment must serialize
  // here) with only the rect swapped to the tight inset.
  const tight = {
    x: vs.rect.x + pad0,
    y: vs.rect.y + pad0,
    w: vs.rect.w - 2 * pad0,
    h: vs.rect.h - 2 * pad0,
  };
  const { visibleShape } = computeFragmentFeathering(
    { ...vs, rect: asLocalRect(tight) } as unknown as LocalShape,
    radius,
  );
  const paddedRect = visibleShape.rect;

  // Re-derive the pose: recover the invariant tight-centre world anchor from the
  // current pose (computeFragmentCenter inverted), then re-apply for the new
  // rect origin — equivalent to computeFragmentCenter(center, rect1) with the
  // SAME centre the fragment was born with.
  const O = getOrientationMatrix(layer.rotation, layer.flip);
  const rotatedOrigin0 = O.apply({ x: vs.rect.x, y: vs.rect.y });
  const worldCenter = { x: layer.cx + rotatedOrigin0.x, y: layer.cy + rotatedOrigin0.y };
  const pose = computeFragmentCenter(worldCenter, { x: paddedRect.x, y: paddedRect.y }, layer.rotation, layer.flip);

  return {
    visibleShape,
    bounding: { w: paddedRect.w, h: paddedRect.h },
    cx: pose.x,
    cy: pose.y,
    // birthCenter MUST track the new pose: snap-to-birth (snapping.ts) compares
    // the layer's cx/cy against the stored birth centre — a stale one would snap
    // the re-feathered fragment to the pre-re-pad position, offsetting the
    // content by exactly the pad delta (real-device finding 2026-10-12).
    birthCenter: { cx: pose.x, cy: pose.y },
  };
},

};

// =================================================================================
// Cut-Link Traversal Utilities
// =================================================================================
//
// Pure functions for traversing the Cut-Link lineage tree (upward and downward).
// Co-located with LayerFactory since both deal with layer structure & metadata.

/**
 * findDownstreamFragments: Find all layers that were cut FROM a given layer.
 *
 * A downstream fragment is a layer whose `metadata.sourceLayerId` equals
 * the given layerId AND has an `assocMaskId` (confirming cut relationship,
 * not just a copy).
 *
 * @param layerId - The source layer to search downstream from
 * @param allLayers - All layers in the frame (flat array)
 * @returns Array of downstream cut fragment layers
 */
export function findDownstreamFragments(layerId: string, allLayers: Layer[]): Layer[] {
  return allLayers.filter(l =>
    !l.hostId && // Only host layers are real fragments (skip exchange/frag triplet sub-layers)
    l.metadata?.sourceLayerId === layerId && l.metadata?.assocMaskId
  );
}

/**
 * findUpstreamAssetId: Trace upward through the Cut-Link chain to find the
 * original source assetId.
 *
 * Walks `metadata.sourceLayerId` links until it finds a layer with an `assetId`,
 * or reaches a dead end. Includes cycle detection.
 *
 * @param layerId - Starting layer id
 * @param frame - The frame containing all layers
 * @returns The root assetId, or null if not resolvable
 */
export function findUpstreamAssetId(layerId: string, frame: Frame): string | null {
  let current = frame.layers.byId[layerId];
  const visited = new Set<string>();

  while (current) {
    if (visited.has(current.id)) return null; // cycle protection
    visited.add(current.id);

    // If current layer has an assetId, that's our root
    if (current.assetId) return current.assetId;

    // Walk up via sourceLayerId
    const parentId = current.metadata?.sourceLayerId as string | undefined;
    if (!parentId) return null;
    current = frame.layers.byId[parentId];
  }
  return null;
}

/**
 * Anti-alias safety margin (px) added to the feather radius when expanding a
 * fragment's crop bbox. Guards the soft edge's outermost falloff row
 * from being clipped by the crop window.
 */
export const AA_MARGIN = 1;

/**
 * computeFragmentFeathering — the CANONICAL feathered-fragment shape as a pure
 * transform: the tight cut geometry serialized to pathData, inset inside a
 * symmetrically PADDED rect (pad = ceil(f) + AA_MARGIN) that carries
 * featherPx. `padded` is the size the fragment's bounding must take so the
 * soft band (which extends f beyond the cut contour) has pixels to render
 * over — an unpadded plane clips the fade and the edges read as hard cuts.
 *
 * Consumers: feathered peel fragment construction (`clipToExistLayer`) and
 * the edge-feather re-pad edit (`patchEdgeFeatherRepad`, which recovers the
 * tight shape by insetting the OLD pad first, then re-outsets through here).
 * Non-path inputs (rect/circle selections) are serialized — a 'rect' shape
 * cannot carry the tight-inside-padded invariant because its rect IS its
 * geometry.
 */
export function computeFragmentFeathering(
  tightShape: LocalShape,
  feather: number,
): { visibleShape: LocalShape; padded: { w: number; h: number } } {
  const pathData = tightShape.type === 'path' && tightShape.pathData
    ? tightShape.pathData
    : shapeToPathData(tightShape);
  // Feather 0 = the historical hard fragment: NO pad at all (the tight form
  // restores bit-exactly — patchEdgeFeatherRepad's radius-0 contract).
  const pad = feather > 0 ? Math.ceil(feather) + AA_MARGIN : 0;
  const tight = tightShape.rect;
  return {
    visibleShape: {
      type: 'path',
      pathData,
      rect: asLocalRect({ x: tight.x - pad, y: tight.y - pad, w: tight.w + 2 * pad, h: tight.h + 2 * pad }),
      antiAliased: tightShape.antiAliased ?? true,
      featherPx: feather,
      __brand: 'local',
    } as unknown as LocalShape,
    padded: { w: tight.w + 2 * pad, h: tight.h + 2 * pad },
  };
}
