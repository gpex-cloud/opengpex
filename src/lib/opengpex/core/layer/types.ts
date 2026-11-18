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

import { Frame, Layer, VectorMask, BitmapMask } from '@opengpex/editor/core/types/models';
import { LocalShape, LocalPolygon, LocalRect, WorldRect, Dimensions, Point2D } from '@opengpex/editor/core/types/primitives';
import type { WorldPoint, NormalizedState } from '@opengpex/editor/core/types';
import type { BakeToAssetOptions, BakeToAssetResult, BuildPhysicalPatchOptions } from './services/baking';
import type { ClipMode, ClipFragmentResult } from './services/clipping/route';
import type { MergeStrategyOp, MergeOptions } from './services/merging';
import type { CompositedImage } from '../engine/types';

/**
 * Cut-link cleanup when removing cut fragments: 'break-link' (default, a plain
 * delete — the hole stays as content, pointer cleared), 'ignore-link' (touch no
 * mask: the caller already wrote the masks, or the rendering must stay
 * exactly as it is).
 */

/**
 * factory namespace: synchronous layer/frame record operations — creation,
 * state changes and reads, all driven through the LayerKind table.
 *
 * Boundary with the other two namespaces is a single rule: factory owns
 * synchronous record work; `clip` / `bake` own the heavy async pixel
 * operations (clip decision table / asset pipeline respectively).
 */
export interface LayerFactoryNamespace {
  getTriplet: (frameId: string, layerId: string) => Triplet | null;
  updateLayer: (frameId: string, runner: (tx: LayerUpdateTx) => void) => void;
  addLayer: (frameId: string, layer: Layer, index?: number) => void;
  addFrame: (frame: Frame, switchFrame?: boolean) => void;
  activate: (frameId: string, layerId: string | null) => void;
  removeLayers: (frameId: string, layerIds: string | string[], opts?: { cutLinks?: 'break-link' | 'ignore-link' }) => void;
  removeFrame: (frameId: string) => void;
  expandLayers: (layers: Layer[]) => Layer[];
  sortLayers: (layers: Layer[]) => Layer[];
  getHostLayers: (layers: Layer[]) => Layer[];
  /** Authored-layer creation entry; see the factory implementation for the full completion pipeline. */
  createLayer: (type: Layer['type'] | 'blank', patch?: Partial<Omit<Layer, 'type'>>) => Layer;
  getNewFrame: (patch: Partial<Frame>) => Frame;
  getNewLayerName: (layers: Array<{ name: string }>, baseName?: string) => string;
  /** Smart name resolved against ALL layers of the frame (the all-layers boilerplate collapsed); filtered-array callers use getNewLayerName directly. */
  getNewLayerNameFor: (frame: Pick<Frame, 'layers'>, baseName?: string) => string;
  /** Pose-preserving geometric quartet rebaser (bounds in → {cx, cy, bounding, visibleShape} out). */
  rebaseToBounds: (bounds: { x: number; y: number; w: number; h: number }, opts?: { snapHalf?: boolean }) => { cx: number; cy: number; bounding: { w: number; h: number }; visibleShape: LocalShape };
  getBlank: () => Partial<Layer>;
  bakedLayerPatch: (bounds: { x: number; y: number; w: number; h: number }, opts?: BuildPhysicalPatchOptions) => Partial<Layer>;
  /** Ingest composition: decode + gamut sniff + asset registration, then layer production. */
  createLayerFromBlob: (blob: Blob, frame: Frame, screenPoint?: { x: number, y: number }) => Promise<Layer>;
  getNewVectorMask: (shape: LocalShape, options?: { maskId?: string; assocLayerId?: string; inverted?: boolean; feather?: number }) => VectorMask;
  getNewBitmapMask: (src: string, assetId: string, bounds: LocalRect) => BitmapMask;
  cleanInheritedMasks: <T extends VectorMask | BitmapMask>(masks?: T[]) => T[];
  getInsertIndexAbove: (frame: Frame, targetLayerId?: string | null) => number | undefined;
  resolveActiveHostLayer: (frame: Frame) => Layer | null;
  /**
   * Layer picking under a world point, with the layer-domain content policy
   * baked in (engine content resolver by default). Topmost-first hits array,
   * or the single topmost layer with `onlyTop`. See `LayerFactory.getLayersAt`.
   */
  getLayersAt: (pos: WorldPoint, layers: NormalizedState<Layer>, options?: { testAlpha?: boolean }) => Layer[];
  /** Topmost hit only (`null` when nothing hits); same content policy as getLayersAt. */
  getTopLayerAt: (pos: WorldPoint, layers: NormalizedState<Layer>, options?: { testAlpha?: boolean }) => Layer | null;
}

/**
 * clip namespace: heavy async pixel operations that route through the clip
 * decision table (fragment production, peel exchange, clipboard physical bake).
 */
export interface LayerClipNamespace {
  clipFragment: (frame: Frame, layer: Layer, options: { mode: ClipMode; feather?: number }) => Promise<ClipFragmentResult>;
  clipToLogicalLayer: (frame: Frame, layer: Layer, options?: { feather?: number; mode?: 'copy' | 'cut'; linkHole?: boolean; selection?: LocalShape | LocalPolygon }) => Promise<{ newLayer: Layer; holeMask?: VectorMask } | null>;
  clipToPhysicalLayer: (frame: Frame, layer: Layer, options?: { feather?: number; clampPlane?: boolean }) => Promise<{ newLayer: Layer, localShape: LocalShape, url: string } | null>;
  clipToExchangeLayer: (frame: Frame, sourceLayer: Layer, targetLayer: Layer, selection: LocalShape | LocalPolygon) => Promise<{ updatedLayer: Layer, localShape: LocalShape, physical: boolean } | null>;
}

/**
 * bake namespace: heavy async pixel operations that run the asset pipeline
 * (merge execution, composite-to-asset bakes, resampling, contour tracing).
 */
export interface LayerBakeNamespace {
  mergeLayers: (frame: Frame, participants: readonly Layer[], options?: MergeOptions) => Promise<MergeStrategyOp>;
  bakeToAsset: (frame: Frame, participants: Layer[], opts?: BakeToAssetOptions) => Promise<BakeToAssetResult>;
  resampleLayer: (frame: Frame, layer: Layer, scaleX: number, scaleY: number) => Promise<{ newUrl: string, newAssetId: string, patch: Partial<Layer> } | null>;
  traceAlphaOutline: (composited: CompositedImage) => Promise<string | null>;
}

/**
 * LayerService: Layer domain model service (Domain: Layer).
 *
 * The service is exactly three namespaces (`factory` / `clip` / `bake`, see
 * their interfaces for the grouping rule): factory owns synchronous
 * layer/frame record operations (creation, state changes, reads — all driven
 * through the LayerKind table); clip / bake own the heavy async pixel
 * operations (clip decision table / asset pipeline respectively).
 */
/**
 * LayerSnapNamespace: LAYER PLACEMENT alignment on the canvas-local integer
 * lattice — the BUSINESS home of the "when does a layer/element box align to
 * the pixel grid" decision. The geometry operators stay pure math (they know
 * HOW to snap, never WHEN); this namespace owns the placement posture:
 * round the top-left (an odd-sized element keeps its natural half-integer
 * center), round the size only when the tool re-derives its bounding from
 * the same box after a resize. It is deliberately distinct from
 * `geometry.snapping` (interactive guide/threshold snapping — a different
 * family) and from the engine's window snap (`snapWorldRectToLatticeExpanded`,
 * engine-internal single source for pixel windows).
 */
export interface LayerSnapNamespace {
  /**
   * Snap a canvas-local placement rect onto the integer lattice: rounds the
   * top-left corner; `snapDimension: true` additionally rounds w/h (tools whose
   * bounding must stay consistent between create and later resize paths).
   * Returns the PLACEMENT RESULT as one bundle — the aligned rect (BRANDED
   * LocalRect: the operator's coordinate-space provenance flows straight
   * through, so consumers never re-wrap), the SAME rect in world coordinates
   * (for callers anchoring in the cx/cy world basis), and its center resolved
   * to world coordinates — a caller building a layer record needs no second
   * center-conversion step.
   */
  snapLayerPlacement: (
    rect: LocalRect,
    canvasDim: Dimensions,
    opts?: { snapDimension?: boolean }
  ) => { rect: LocalRect; worldRect: WorldRect; worldCenter: Point2D };
}

export interface LayerService {
  /** Synchronous layer/frame record operations (creation + state changes + reads). */
  factory: LayerFactoryNamespace;
  /** Heavy async clip operations (clip decision table). */
  clip: LayerClipNamespace;
  /** Heavy async bake operations (asset pipeline). */
  bake: LayerBakeNamespace;
  /** Layer placement alignment on the document pixel lattice (business posture). */
  snap: LayerSnapNamespace;
}
/**
 * Triplet: Triplet structure (peel session: host / exchange / stamps)
 */
export interface Triplet {
  host: Layer;
  exchange: Layer;
  /** All temporary stamp sub-layers (role 'frag'), in frame z-order. */
  frags: Layer[];
}

/**
 * LayerUpdateTx: Layer update transaction manager
 */
export interface LayerUpdateTx {
  /** Gets the editor handle for a specific layer */
  edit: (layerId: string) => LayerEditor;
}

/**
 * LayerEditor: Layer attribute editor (chained operation handle)
 */
export interface LayerEditor {
  /** Sets asset information */
  setAsset: (asset: { assetId: string, url: string }) => LayerEditor;
  /** Sets geometric properties */
  // setPose: (pose: Partial<{ cx: number, cy: number, scale: number, rotation: number, flip: { h: boolean, v: boolean } }>) => LayerEditor;
  /** Sets shape and visible area (supports rect/circle/path) */
  setShape: (shape: { visibleShape?: LocalShape, bounding?: Dimensions }) => LayerEditor;
  /** Removes masks (supports pattern matching) */
  removeMask: (pattern: string) => LayerEditor;
  /** Adds a mask */
  applyMask: (shape: LocalShape, options?: { maskId?: string; assocLayerId?: string; inverted?: boolean; feather?: number }) => LayerEditor;
  /** General patch (for quickly setting other attributes) */
  patch: (data: Partial<Layer>) => LayerEditor;
  /** Resets the layer to the system default blank state */
  reset: () => LayerEditor;
  /** Clears layer content, keeping the layer (used in scenarios like Cut without selection) */
  /** Hides layer content with a full-screen inverted mask, keeping the layer (non-destructive Cut) */
  maskLayer: () => LayerEditor;
  /** Resets layer pose, opacity, filters, and masks after flattening merge, specifying new dimensions */
  resetWithBounds: (w: number, h: number, cx: number, cy: number) => LayerEditor;
  /** Sets opacity */
  setOpacity: (opacity: number) => LayerEditor;
  /** Sets visibility */
  setVisible: (visible: boolean) => LayerEditor;

  // --- Bitmap Mask operations ---
  /** Adds a bitmap mask */
  applyBitmapMask: (src: string, assetId: string, bounds: LocalRect) => LayerEditor;
  /** Removes a bitmap mask */
  removeBitmapMask: (maskId: string) => LayerEditor;
  /** Updates bitmap mask asset (called after eraser baking) */
  updateBitmapMask: (maskId: string, patch: Partial<BitmapMask>) => LayerEditor;
}
