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
import { LocalShape, LocalPolygon, LocalRect, Dimensions } from '@opengpex/editor/core/types/primitives';
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
 * LayerService: Layer domain model service (Domain: Layer)
 */
export interface LayerService {
  /** Identifies and gets the triplet structure the layer belongs to */
  getTriplet: (frameId: string, layerId: string) => Triplet | null;
  /** Starts a layer update transaction */
  updateLayer: (frameId: string, runner: (tx: LayerUpdateTx) => void) => void;
  /** Adds a layer (automatically handles expansion logic) */
  addLayer: (frameId: string, layer: Layer, index?: number) => void;
  /** Adds an artboard */
  addFrame: (frame: Frame, switchFrame?: boolean) => void;

  /** Activates (selects) a specific layer */
  activate: (frameId: string, layerId: string | null) => void;

  /**
   * Removes layer(s) (supports single or multi selection). `cutLinks` decides
   * what happens to a removed cut fragment's hole on its source —
   * `'break-link'` (default) clears the deleted fragments' cut pointers on
   * their sources; `'ignore-link'` touches no mask (for callers that already
   * wrote masks themselves: bake, Merge Back). A plain delete never heals.
   */
  removeLayers: (frameId: string, layerIds: string | string[], opts?: { cutLinks?: 'break-link' | 'ignore-link' }) => void;

  /** Removes an artboard (automatically cascades deletes to descendant artboards and migrates focus) */
  removeFrame: (frameId: string) => void;

  // --- Factory Logic (Pure) ---
  expandLayers: (layers: Layer[]) => Layer[];
  getHostLayers: (layers: Layer[]) => Layer[];
  getNewLayer: (patch: Partial<Layer>) => Layer;
  getNewFrame: (patch: Partial<Frame>) => Frame;
  getNewLayerName: (layers: Array<{ name: string }>, baseName?: string) => string;
  sortLayers: (layers: Layer[]) => Layer[];
  /** Unified fragment entry point — logical first, vectorMask fallback */
  /** Returns the fragment layer plus, in cut mode, the fully-formed hole VectorMask to append to the source layer. */
  clipToLogicalLayer: (frame: Frame, layer: Layer, options?: { feather?: number; mode?: 'copy' | 'cut'; linkHole?: boolean; selection?: LocalShape | LocalPolygon }) => Promise<{ newLayer: Layer; holeMask?: VectorMask } | null>;
  /** Physical fragment: always produces a baked PNG blob (needed for clipboard external paste) */
  clipToPhysicalLayer: (frame: Frame, layer: Layer, options?: { feather?: number; clampPlane?: boolean }) => Promise<{ newLayer: Layer, localShape: LocalShape, url: string } | null>;
  /** Resamples layer to a new resolution: uniform scale preserves the non-destructive structure (zero-copy shared src, visibleShape offset, vector/bitmap masks scaled geometrically); non-uniform scale flattens (bakes) the layer. */
  resampleLayer: (frame: Frame, layer: Layer, scaleX: number, scaleY: number) => Promise<{ newUrl: string, newAssetId: string, patch: Partial<Layer> } | null>;
  /**
   * Single entry for Copy / Layer via Copy / Cut / Layer via Cut: routes by
   * layer type, selection overlap and mode through the clip decision table and
   * returns the product plus the mask to append to the source layer.
   */
  clipFragment: (frame: Frame, layer: Layer, options: { mode: ClipMode; feather?: number }) => Promise<ClipFragmentResult>;
  /**
   * Single entry for the merge commands (merge selected, merge down): routes the
   * participant set through the merge decision table and runs the chosen
   * executor — a zero-rasterization logical union for same-source fragment
   * sets, a physical bake for everything else. A refused merge (group
   * participants, cross-group boundary) surfaces the table's HUD message.
   * Participants are ordered bottom to top.
   */
  mergeLayers: (frame: Frame, participants: readonly Layer[], options?: MergeOptions) => Promise<MergeStrategyOp>;
  /**
   * Applies a fragment to an existing layer (the peel Exchange layer):
   * logical (shared source asset) when the source's masks fold into hard
   * geometry, otherwise a baked bitmap the target owns (`physical`). Null
   * when the selection holds no pixel of the source.
   */
  clipToExchangeLayer: (frame: Frame, sourceLayer: Layer, targetLayer: Layer, selection: LocalShape | LocalPolygon) => Promise<{ updatedLayer: Layer, localShape: LocalShape, physical: boolean } | null>;
  /**
   * Physical-bake family (services/baking.ts): composite the participants
   * through the single WebGPU RenderGraph, register the result as an asset,
   * and warm the decoded bitmap BEFORE the caller's state update. The one
   * pipeline every bake site shares (whole-layer merges, peel commit,
   * fragment transform bake).
   */
  bakeToAsset: (frame: Frame, participants: Layer[], opts?: BakeToAssetOptions) => Promise<BakeToAssetResult>;
  /**
   * Physical-bake product-record conventions: pose reset to factory values,
   * full-bounds rect crop release, grade chain stripped, plus the caller's
   * record specifics (snapHalf center, preserved flip, snap-to-birth anchor).
   */
  bakedLayerPatch: (bounds: { x: number; y: number; w: number; h: number }, opts?: BuildPhysicalPatchOptions) => Partial<Layer>;
  /**
   * Rebuilds a baked composite's contour from its own pixel alpha and
   * serialises it to pathData (product-local space). Failure-safe: null on
   * any decode/trace failure — callers keep the full-bounds rect.
   */
  traceAlphaOutline: (composited: CompositedImage) => Promise<string | null>;
  /** Creates a layer from an external image Blob (handles asset registration and position calculation) */
  createLayerFromBlob: (blob: Blob, frame: Frame, screenPoint?: { x: number, y: number }) => Promise<Layer>;
  getBlank: () => Partial<Layer>;
  getNewVectorMask: (shape: LocalShape, options?: { maskId?: string; assocLayerId?: string; inverted?: boolean; feather?: number }) => VectorMask;
  getNewBitmapMask: (src: string, assetId: string, bounds: LocalRect) => BitmapMask;
  cleanInheritedMasks: <T extends VectorMask | BitmapMask>(masks?: T[]) => T[];
  getInsertIndexAbove: (frame: Frame, targetLayerId?: string | null) => number | undefined;
  /** Host layer the active selection belongs to (triplet sub-layers resolve to their host). */
  resolveActiveHostLayer: (frame: Frame) => Layer | null;
  /** Host layer directly above an insertion slot (triplet sub-layers resolve to their host). */
  resolveHostAbove: (frame: Frame, insertAt: number | undefined) => Layer | null;
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
  emptyLayer: () => LayerEditor;
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
