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

import { GeometryService, PixelService, AssetService, LayerService, LayerUpdateTx, LayerEditor, asLocalShape, EditorActions, EditorData, Layer, VectorMask, BitmapMask, GamutId } from '@opengpex/editor/core/types';
import { sniffPngGamut } from '@opengpex/editor/core/files/utils';
import { LayerFactory } from './factory';
import { createFragmentOperations } from './services/clipping/strategies';
import { createResampleOperations } from './services/resizing';
import { createBakeOperations } from './services/baking';
import { createClipRoutingOperations } from './services/clipping/route';
import { createMergeOperations } from './services/merging';

export function createLayerService(
  geometry: GeometryService,
  pixels: PixelService,
  assets: AssetService,
  actions: EditorActions,
  getState: () => EditorData
): LayerService {
  // ── Delegate fragment and resample operations to dedicated modules ──
  const fragmentOps = createFragmentOperations(geometry, pixels, assets);
  const resampleOps = createResampleOperations(geometry, pixels, assets);
  const bakeOps = createBakeOperations(geometry, pixels, assets);
  const clipRoutingOps = createClipRoutingOperations(geometry, fragmentOps, bakeOps);

  // The merge entry consumes the service itself (bakeToAsset, updateLayer,
  // removeLayers, activate), so it cannot be built inside the literal — the
  // method here just delegates to an implementation that is wired right
  // after the literal, over the assembled service.
  const mergeOps: { impl: LayerService['mergeLayers'] } = {
    // Replaced synchronously right after the service literal below — never
    // called before that.
    impl: (_frame, _participants, _options) => {
      throw new Error('[LayerService] mergeLayers is wired after service construction');
    },
  };
  const service: LayerService = {
    ...LayerFactory,
    mergeLayers: (frame, participants, options) => mergeOps.impl(frame, participants, options),

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
            applyMask: (shape, options?) => {
              const currentMasks = patches[layerId].vectorMasks || [];
              const newMask = LayerFactory.getNewVectorMask(shape, options);
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
                { inverted: true }
              );

              patches[layerId].vectorMasks = [...(patches[layerId].vectorMasks || []), fullMask];
              return editor;
            },
            resetWithBounds: (w, h, cx, cy) => {
              const { flip, opacity, vectorMasks } = LayerFactory.getNewLayer();
              patches[layerId] = {
                ...patches[layerId],
                // Shared physical-record core (services/baking.ts): pose reset,
                // full-bounds rect crop release, grade chain stripped. The
                // patch is rect-driven (it derives the center from the rect),
                // so the incoming center is reconstructed into a bounds rect
                // — values come out identical (no rounding on this path).
                ...bakeOps.bakedLayerPatch({ x: cx - w / 2, y: cy - h / 2, w, h }),
                // A reset layer holds freshly baked pixels: pose extras that
                // the shared core deliberately leaves to the caller.
                flip, opacity, vectorMasks,
                // The physical-layer declaration (see services/baking.ts): a
                // reset layer OWNS its pixels. Existing metadata keys
                // (lineage pointers) survive the declaration.
                metadata: { ...(layer?.metadata ?? {}), physicalPixels: true },
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
    removeLayers: (frameId: string, layerIds: string | string[], opts?: { cutLinks?: 'break-link' | 'ignore-link' }) => {
      const frame = getState().frames.byId[frameId];
      if (!frame) return;

      // What happens to a removed cut fragment's hole on its source:
      //   'break-link' (default — a plain delete): deletion never heals (2026-11-08
      //     ruling). The hole stays as content but loses its `assocLayerId`,
      //     so it renders at its true cut line (the renderer reads that
      //     field's presence as the cut-seam backing switch) and no longer
      //     counts as a mergeable fragment. Restoring the source is Merge
      //     Back / Merge Fragments' job.
      //   'ignore-link': touch no mask — for callers that already wrote the
      //     sources' masks themselves (Merge Back) or must leave the
      //     rendering exactly as it is (bake: the merge preserves
      //     the picture, and a backed hole re-rendered unlinked would grow by
      //     the backing bias). Writing from this snapshot would also clobber
      //     those callers' just-dispatched mask writes.
      const cutLinks: 'break-link' | 'ignore-link' = opts?.cutLinks ?? 'break-link';
      const targetIds = Array.isArray(layerIds) ? layerIds : [layerIds];
      const allLayers = frame.layers.order.map(id => frame.layers.byId[id]);
      const idsToRemove = LayerFactory.collectDescendants(targetIds, allLayers);

      // Per source layer: mask ids whose pointer to unlink (delete).
      // Collected up front to avoid stale-snapshot overwrites when multiple
      // fragments / triplet sub-layers target the same source.
      const maskIdsBySource = new Map<string, Set<string>>();
      for (const removeId of cutLinks === 'ignore-link' ? [] : idsToRemove) {
        const layer = frame.layers.byId[removeId];
        if (!layer || layer.hostId) continue; // Only host layers trigger cleanup (skip exchange/frag triplet sub-layers)
        const sourceLayerId = layer.metadata?.sourceLayerId as string | undefined;
        const assocMaskId = layer.metadata?.assocMaskId as string | undefined;
        if (sourceLayerId && assocMaskId && !idsToRemove.has(sourceLayerId)) {
          if (!maskIdsBySource.has(sourceLayerId)) maskIdsBySource.set(sourceLayerId, new Set());
          maskIdsBySource.get(sourceLayerId)!.add(assocMaskId);
        }
      }
      for (const [sourceLayerId, maskIds] of maskIdsBySource) {
        const sourceLayer = frame.layers.byId[sourceLayerId];
        if (!sourceLayer?.vectorMasks) continue;
        const updatedMasks = sourceLayer.vectorMasks
          .map(m => (cutLinks === 'break-link' && maskIds.has(m.id)) ? { ...m, assocLayerId: undefined } : m);
        const original = sourceLayer.vectorMasks;
        const changed = updatedMasks.length !== original.length
          || updatedMasks.some((m, i) => m !== original[i]);
        if (changed) {
          actions.updateLayer(frameId, sourceLayerId, { vectorMasks: updatedMasks });
        }
      }

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

    // ── Clip operations (delegated to clipping.ts) ──────────────────────────
    clipToLogicalLayer: fragmentOps.clipToLogicalLayer,
    clipToPhysicalLayer: fragmentOps.clipToPhysicalLayer,
    clipToExistLayer: fragmentOps.clipToExistLayer,
    clipFragment: clipRoutingOps.clipFragment,

    // ── Resample operations (delegated to resizing.ts) ──────────────────────────
    resampleLayer: resampleOps.resampleLayer,

    // ── Bake operations (delegated to baking.ts) ──────────────────────────────────
    bakeToAsset: bakeOps.bakeToAsset,
    bakedLayerPatch: bakeOps.bakedLayerPatch,
    traceAlphaOutline: bakeOps.traceAlphaOutline,

    createLayerFromBlob: async (blob, frame, screenPoint) => {
      const bmp = await createImageBitmap(blob);
      const dim = { w: bmp.width, h: bmp.height };
      bmp.close();

      // Best-effort gamut sniff from the blob's embedded ICC profile: external
      // pastes carry no ingest metadata, and tagging a Display-P3 screenshot
      // as sRGB would shift every hue. The sniff only ever returns gamuts the
      // 8-bit resident lane decodes correctly (see gamutSniff.ts) — anything
      // else falls through to the untagged sRGB default. Never throws.
      let snGamut: GamutId | undefined;
      try {
        snGamut = await sniffPngGamut(new Uint8Array(await blob.arrayBuffer()));
      } catch {
        snGamut = undefined; // enrichment only — default identity wins
      }
      const { assetId, url } = await assets.register(blob, {
        width: dim.w,
        height: dim.h,
        ...(snGamut ? { gamut: snGamut } : {}),
      });

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

  mergeOps.impl = createMergeOperations(geometry, service, actions).mergeLayers;

  return service;
}

export * from './factory';
