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

import { LAYER_ROLE_CONFIGS, HOST_LAYER_ORDER } from '@opengpex/editor/core/helpers/config';
import {
  Layer, Frame, VectorMask, BitmapMask, LayerRole,
  LocalShape, LocalRect, asLocalShape
} from '@opengpex/editor/core/types';

/** Type-safe role configuration index helper */
const roleConfigMap = LAYER_ROLE_CONFIGS as Record<string, { label: string; order: number; follow: boolean } | undefined>;

const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

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

    return {
      id,
      name: 'New Project',
      canvas: { w: 0, h: 0 },
      rotation: 0,
      layers: { byId: {}, order: [] },
      camera: { x: 0, y: 0, k: 1 },
      imageCropBox: asLocalShape({ x: 0, y: 0, w: 0, h: 0 }),
      canvasCropBox: asLocalShape({ x: 0, y: 0, w: 0, h: 0 }),
      ...patch
    } as Frame;
  },

  /**
   * getNewLayer: Layer production factory (formerly createLayer)
   * Completes the ID and all default values, returning a complete layer instance.
   */
  getNewLayer(patch: Partial<Layer> = {}): Layer {
    const id = patch.id || `l-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 5)}`;

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
      adjustments: {
        brightness: 100,
        contrast: 100,
        saturation: 100,
        hueRotate: 0,
        blur: 0
      },
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
   * getNewVectorMask: Creates a standardized vector mask object.
   */
  getNewVectorMask(shape: LocalShape, inverted = false): VectorMask {
    return {
      id: `mask-${shape.type}-${Date.now()}`,
      shape: { ...shape } as LocalShape,
      inverted,
      feather: 0,
      enabled: true
    };
  },

  /**
   * getNewBitmapMask: Creates a standardized bitmap mask object.
   */
  getNewBitmapMask(src: string, assetId: string, bounds: LocalRect): BitmapMask {
    return {
      id: `bmask-${Date.now()}`,
      src,
      assetId,
      bounds,
      inverted: false,
      enabled: true,
      feather: 0
    };
  },

  /**
   * getBlank: Returns a standardized "empty" layer patch. Invisible, non-interactive, no asset.
   */
  getBlank(): Partial<Layer> {
    return {
      src: TRANSPARENT_PIXEL,
      assetId: 'asset-transparent-pixel',
      visible: false,
      interactive: false,
      vectorMasks: [],
      visibleShape: { type: 'rect', rect: { x: 0, y: 0, w: 0, h: 0 }, hardEdge: false, __brand: 'local' } as LocalShape,
    };
  },

  /**
   * getNewLayerName: Smart naming engine, automatically handling increment logic like "Copy 2".
   */
  getNewLayerName(layers: Array<{ name: string }>, baseName: string): string {
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
      if (layer.parentId) return;

      const hasChildren = layers.some(l => l.parentId === layer.id);
      if (hasChildren) return;

      Object.entries(LAYER_ROLE_CONFIGS).forEach(([role, _config]) => {
        result.push({
          ...layer,
          ...this.getBlank(),
          id: `${layer.id}_${role}`,
          name: layer.name,
          role: role as LayerRole,
          parentId: layer.id,
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
    layers.filter(l => !l.parentId).forEach((l, i) => hostOrderMap.set(l.id, i));

    return [...layers].sort((a, b) => {
      const orderA = a.role ? roleConfigMap[a.role]?.order ?? HOST_LAYER_ORDER : HOST_LAYER_ORDER;
      const orderB = b.role ? roleConfigMap[b.role]?.order ?? HOST_LAYER_ORDER : HOST_LAYER_ORDER;

      if (orderA !== orderB) return orderA - orderB;

      const hostIdA = a.parentId || a.id;
      const hostIdB = b.parentId || b.id;
      return (hostOrderMap.get(hostIdA) ?? 0) - (hostOrderMap.get(hostIdB) ?? 0);
    });
  },


  // =================================================================================
  // 3. Domain Relationship
  // =================================================================================

  /**
   * getTriplet: Identifies and gets the triplet (Host/Exchange/Frag) the layer belongs to and its dirty state.
   */
  getTriplet(layer: Layer, layers: Layer[]) {
    const isHost = !layer.parentId || layer.role === 'host';
    const hostId = isHost ? layer.id : layer.parentId;

    const host = layers.find(l => l.id === hostId);
    if (!host) return null;

    const exchange = layers.find(l => l.parentId === hostId && l.role === 'exchange');
    const frag = layers.find(l => l.parentId === hostId && l.role === 'frag');

    if (!exchange) return null;

    const dirty = exchange.src !== TRANSPARENT_PIXEL && exchange.visible;

    return {
      group: { host, exchange, frag },
      dirty
    };
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
        if (l.parentId === layerId) {
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
    return layers.filter(l => !l.parentId);
  },

  /**
   * canLayerBeActivated: Determines if the layer can be activated (selected) by the user.
   */
  canLayerBeActivated(layer: Layer): boolean {
    if (!layer.parentId) return true;
    if (layer.role && layer.role in LAYER_ROLE_CONFIGS) return true;
    return false;
  },

};
