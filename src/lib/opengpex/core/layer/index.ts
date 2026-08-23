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

import { GeometryService, PixelService, AssetService, LayerService, LayerUpdateTx, LayerEditor, asLocalShape, EditorActions, EditorData, Layer, VectorMask, BitmapMask } from '@opengpex/editor/core/types';
import { LayerFactory } from './factory';
import { createFragmentOperations } from './services/fragment';
import { createResampleOperations } from './services/resample';

export function createLayerService(
  geometry: GeometryService,
  pixels: PixelService,
  assets: AssetService,
  actions: EditorActions,
  getState: () => EditorData
): LayerService {
  // ── Delegate fragment and resample operations to dedicated modules ──
  const fragmentOps = createFragmentOperations(geometry, pixels);
  const resampleOps = createResampleOperations(geometry, pixels);

  return {
    ...LayerFactory,

    updateLayer: (frameId, runner) => {
      const state = getState();
      const frame = state.frames.byId[frameId];
      if (!frame) return;

      const patches: Record<string, Partial<Layer>> = {};

      const tx: LayerUpdateTx = {
        edit: (layerId) => {
          const layer = frame.layers.byId[layerId];
          if (!layer) {
            console.warn(`[LayerTx] Layer ${layerId} not found in frame ${frameId}`);
          }

          // 🌟 Initialize vectorMasks in draft to avoid duplicate fallbacks later
          if (!patches[layerId]) {
            patches[layerId] = {};
          }
          if (patches[layerId].vectorMasks === undefined) {
            patches[layerId].vectorMasks = layer?.vectorMasks || [];
          }

          const editor: LayerEditor = {
            setAsset: (asset) => {
              patches[layerId] = { ...patches[layerId], src: asset.url, assetId: asset.assetId };
              return editor;
            },
            setShape: (shape) => {
              patches[layerId] = { ...patches[layerId], ...shape };
              return editor;
            },
            removeMask: (pattern) => {
              const currentMasks = patches[layerId].vectorMasks || [];
              const newMasks = currentMasks.filter((m: VectorMask) => !m.id.includes(pattern));
              patches[layerId].vectorMasks = newMasks;
              return editor;
            },
            applyMask: (shape, inverted = false, feather = 0) => {
              const currentMasks = patches[layerId].vectorMasks || [];
              const newMask = LayerFactory.getNewVectorMask(shape, inverted, feather);
              patches[layerId].vectorMasks = [...currentMasks, newMask];
              return editor;
            },
            patch: (data) => {
              patches[layerId] = { ...patches[layerId], ...data };
              return editor;
            },
            reset: () => {
              patches[layerId] = { ...LayerFactory.getBlank() };
              return editor;
            },
            emptyLayer: () => {
              patches[layerId] = {
                ...patches[layerId],
                src: LayerFactory.TRANSPARENT_PIXEL,
                assetId: 'asset-transparent-pixel',
                vectorMasks: []
              };
              return editor;
            },
            maskLayer: () => {
              const currentLayer = layer;
              if (!currentLayer) return editor;

              const fullMask = LayerFactory.getNewVectorMask(
                asLocalShape({ x: 0, y: 0, w: currentLayer.bounding.w, h: currentLayer.bounding.h }, 'rect'),
                true
              );

              patches[layerId].vectorMasks = [...(patches[layerId].vectorMasks || []), fullMask];
              return editor;
            },
            resetWithBounds: (w, h, cx, cy) => {
              const { rotation, flip, opacity, adjustments, vectorMasks } = LayerFactory.getNewLayer();
              patches[layerId] = {
                ...patches[layerId],
                cx, cy,
                bounding: { w, h },
                visibleShape: asLocalShape({ x: 0, y: 0, w, h }),
                scale: 1, rotation, flip, opacity, adjustments, vectorMasks,
              };
              return editor;
            },
            setOpacity: (opacity) => {
              patches[layerId] = { ...patches[layerId], opacity };
              return editor;
            },
            setVisible: (visible) => {
              patches[layerId] = { ...patches[layerId], visible };
              return editor;
            },

            // --- Bitmap Mask operations ---
            applyBitmapMask: (src, assetId, bounds) => {
              const currentBitmapMasks = patches[layerId].bitmapMasks || layer?.bitmapMasks || [];
              const newMask = LayerFactory.getNewBitmapMask(src, assetId, bounds);
              patches[layerId].bitmapMasks = [...currentBitmapMasks, newMask];
              return editor;
            },
            removeBitmapMask: (maskId) => {
              const currentBitmapMasks = patches[layerId].bitmapMasks || layer?.bitmapMasks || [];
              patches[layerId].bitmapMasks = currentBitmapMasks.filter((m: BitmapMask) => m.id !== maskId);
              return editor;
            },
            updateBitmapMask: (maskId, maskPatch) => {
              const currentBitmapMasks = patches[layerId].bitmapMasks || layer?.bitmapMasks || [];
              patches[layerId].bitmapMasks = currentBitmapMasks.map((m: BitmapMask) =>
                m.id === maskId ? { ...m, ...maskPatch } : m
              );
              return editor;
            }
          };
          return editor;
        }
      };

      // Execute transaction logic
      runner(tx);

      // --- Core Enhancement: Cascade Calculation ---
      const finalPatches: Record<string, Partial<Layer>> = {};

      const layersArray = frame.layers.order.map(id => frame.layers.byId[id]);
      Object.entries(patches).forEach(([layerId, patch]) => {
        const cascade = LayerFactory.getLayerCascadePatches(layersArray, layerId, patch);
        Object.assign(finalPatches, cascade);
      });

      // Summarize and commit
      if (Object.keys(finalPatches).length > 0) {
        actions.batchUpdateLayers(frameId, finalPatches);
      }
    },


    addLayer: (frameId, layer, index) => {
      const expanded = LayerFactory.expandLayers([layer]);
      actions.addLayers(frameId, expanded, index);
    },

    addFrame: (frame, switchFrame = true) => {
      actions.addFrame(frame, switchFrame);
    },

    activate: (frameId, layerId) => {
      if (layerId) {
        const state = getState();
        const frame = state.frames.byId[frameId];
        const layer = frame?.layers.byId[layerId];
        if (layer && !LayerFactory.canLayerBeActivated(layer)) return;
      }
      actions.setActiveLayer(frameId, layerId);
    },

    // Upgraded version: supports passing either a single ID or an array of IDs (multi-selection delete)
    removeLayers: (frameId: string, layerIds: string | string[]) => {
      const frame = getState().frames.byId[frameId];
      if (!frame) return;

      const targetIds = Array.isArray(layerIds) ? layerIds : [layerIds];
      const allLayers = frame.layers.order.map(id => frame.layers.byId[id]);
      const idsToRemove = LayerFactory.collectDescendants(targetIds, allLayers);

      // Focus migration: pick nearest host layer if active is being removed
      let nextActiveId: string | null = frame.activeLayerId ?? null;
      if (!nextActiveId || idsToRemove.has(nextActiveId)) {
        const candidates = LayerFactory.getHostLayers(allLayers.filter(l => !idsToRemove.has(l.id)));
        const targetIndex = frame.layers.order.indexOf(targetIds[0]);
        const safeIndex = Math.min(targetIndex, candidates.length - 1);
        nextActiveId = candidates[safeIndex >= 0 ? safeIndex : 0]?.id ?? null;
      }

      actions.removeLayers(frameId, Array.from(idsToRemove), nextActiveId);
    },

    removeFrame: (frameId: string) => {
      const state = getState();
      const allFrames = state.frames.order.map(id => state.frames.byId[id]);
      // Map Frame.parentId → hostId so collectDescendants can traverse the trunk→branch tree
      const asHostItems = allFrames.map(f => ({ id: f.id, hostId: f.parentId ?? null }));
      const idsToRemove = LayerFactory.collectDescendants([frameId], asHostItems);

      // Focus migration: pick first surviving frame
      let nextActiveFrameId: string | null = state.activeFrameId ?? null;
      if (nextActiveFrameId && idsToRemove.has(nextActiveFrameId)) {
        nextActiveFrameId = allFrames.find(f => !idsToRemove.has(f.id))?.id ?? null;
      }

      actions.removeFrame(Array.from(idsToRemove), nextActiveFrameId);
    },

    getTriplet: (frameId, layerId) => {
      const state = getState();
      const frame = state.frames.byId[frameId];
      const layer = frame?.layers.byId[layerId];
      if (!layer || !frame) return null;

      return LayerFactory.getTriplet(layer, frame.layers.order.map(id => frame.layers.byId[id]));
    },

    // ── Fragment operations (delegated to fragment.ts) ──────────────────────────
    fragmentToLayer: fragmentOps.fragmentToLayer,
    fragmentToLayerPhysical: fragmentOps.fragmentToLayerPhysical,
    fragmentToExistLayer: fragmentOps.fragmentToExistLayer,

    // ── Resample operations (delegated to resample.ts) ──────────────────────────
    resampleLayerPhysical: resampleOps.resampleLayerPhysical,

    createLayerFromBlob: async (blob, frame, screenPoint) => {
      const bmp = await createImageBitmap(blob);
      const dim = { w: bmp.width, h: bmp.height };
      bmp.close();
      const { assetId, url } = await assets.register(blob, dim);

      // layer.cx/cy uses the world coordinate system (origin at canvas center), directly using the screenToWorld result
      let cx, cy;
      if (screenPoint) {
        const worldPos = geometry.space.screenToWorld(screenPoint.x, screenPoint.y, frame);
        cx = worldPos.x;
        cy = worldPos.y;
      } else {
        const state = getState();
        const vDim = state.ui.viewportDim;
        const worldCenter = geometry.space.screenToWorld(vDim.w / 2, vDim.h / 2, frame);
        cx = worldCenter.x;
        cy = worldCenter.y;
      }

      const layersArray = frame.layers.order.map(id => frame.layers.byId[id]);
      const smartName = LayerFactory.getNewLayerName(layersArray, 'Pasted');

      return LayerFactory.getNewLayer({
        name: smartName,
        src: url,
        assetId: assetId,
        cx,
        cy,
        bounding: dim,
        visibleShape: asLocalShape({ x: 0, y: 0, w: dim.w, h: dim.h }),
        birthCenter: { cx, cy }
      });
    },
  };
}

export * from './factory';
