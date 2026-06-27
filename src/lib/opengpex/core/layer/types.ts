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

  /** Removes layer(s) (supports single or multi selection) */
  removeLayers: (frameId: string, layerIds: string | string[]) => void;

  /** Removes an artboard (automatically cascades deletes to descendant artboards and migrates focus) */
  removeFrame: (frameId: string) => void;

  // --- Factory Logic (Pure) ---
  expandLayers: (layers: Layer[]) => Layer[];
  getHostLayers: (layers: Layer[]) => Layer[];
  getNewLayer: (patch: Partial<Layer>) => Layer;
  getNewFrame: (patch: Partial<Frame>) => Frame;
  getNewLayerName: (layers: Array<{ name: string }>, baseName: string) => string;
  sortLayers: (layers: Layer[]) => Layer[];
  fragmentToLayerPhysical: (frame: Frame, layer: Layer, nameType: string) => Promise<{ newLayer: Layer, localShape: LocalShape, url: string } | null>;
  fragmentToLayerLogical: (frame: Frame, layer: Layer, nameType: string) => { newLayer: Layer, localShape: LocalShape } | null;
  /** Physically resamples layer: adjusts pixel resolution and proportionally scales visible areas and masks */
  resampleLayerPhysical: (layer: Layer, scaleX: number, scaleY: number) => Promise<{ newUrl: string, newAssetId: string, patch: Partial<Layer> } | null>;
  /** Applies a fragment to an existing layer (e.g. Exchange layer) */
  fragmentToExistLayer: (frame: Frame, sourceLayer: Layer, targetLayer: Layer, selection: LocalShape | LocalPolygon) => { updatedLayer: Layer, localShape: LocalShape } | null;
  /** Creates a layer from an external image Blob (handles asset registration and position calculation) */
  createLayerFromBlob: (blob: Blob, frame: Frame, screenPoint?: { x: number, y: number }) => Promise<Layer>;
  getBlank: () => Partial<Layer>;
  getNewVectorMask: (shape: LocalShape, inverted?: boolean, feather?: number) => VectorMask;
  getNewBitmapMask: (src: string, assetId: string, bounds: LocalRect) => BitmapMask;
}

/**
 * Triplet: Triplet structure (composite layer relationship)
 */
export interface Triplet {
  group: {
    host: Layer;
    exchange: Layer;
    frag?: Layer;
  };
  /** Determines if the triplet is in a "pending settlement" dirty state */
  dirty: boolean;
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
  setAsset: (asset: { id: string, url: string }) => LayerEditor;
  /** Sets geometric properties */
  // setPose: (pose: Partial<{ cx: number, cy: number, scale: number, rotation: number, flip: { h: boolean, v: boolean } }>) => LayerEditor;
  /** Sets shape and visible area (supports rect/circle/path) */
  setShape: (shape: { visibleShape?: LocalShape, bounding?: Dimensions }) => LayerEditor;
  /** Removes masks (supports pattern matching) */
  removeMask: (pattern: string) => LayerEditor;
  /** Adds a mask */
  applyMask: (shape: LocalShape, inverted?: boolean, feather?: number) => LayerEditor;
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
