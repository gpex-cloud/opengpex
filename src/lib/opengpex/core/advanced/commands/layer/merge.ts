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

'use client';

import { EditorContextValue, EditorCommand, Layer } from '@opengpex/editor/core/types';
import * as P from '@opengpex/editor/core/advanced/protocols';

// ─── Shared composite helper ────────────────────────────────────────────────
/**
 * compositeLayersToAsset — Delegates to `pixels.render.compositeLayers()` to
 * compute the union shape and composite, then injects the result as an asset.
 * Returns the asset reference and the computed union geometry.
 */
async function compositeLayersToAsset(
  layers: Layer[],
  ctx: Pick<EditorContextValue, 'pixels' | 'assets' | 'activeFrame'>,
) {
  const { pixels, activeFrame } = ctx;
  if (!activeFrame) throw new Error('No active frame');

  const { result, bounds } = await pixels.render.compositeLayers(layers, activeFrame);

  const asset = await result.toAsset();
  if (!asset.assetId) throw new Error('Composite failed');

  // Ensure bitmap is decoded into SourceBitmapCache before state update.
  // toAsset().inject() creates an object URL backed by the in-memory blob;
  // loadBitmap is cache-first and fetches from that URL (no network, instant).
  await pixels.image.loadBitmap(asset.url);

  return { asset, bounds };
}

/**
 * LayerMergeCommands: Advanced layer merge commands.
 *
 * Step 8 migration: All merge/rasterize operations now use the unified
 * `pixels.composite()` pipeline instead of the old scattered APIs:
 *   - pixels.worker.mergeLayersWithShape → pixels.composite()
 *   - pixels.render.flattenLayers → pixels.composite()
 *   - preRasterizeLayers → handled internally by pipeline's IStrategyResolver
 *
 * The pipeline internally resolves layer strategies (text/color/bitmap/raw),
 * selects the best backend (Canvas2D 8-bit / HighDepth 16-bit), and produces
 * a CompositeResult. Asset injection uses result.toAsset() which delegates
 * to the injected assetInjector wired by PixelService.
 *
 */
export const LayerMergeCommands = {
  mergeDown: {
    id: P.ADV_LAYER_MERGE_DOWN,
    name: 'Merge Layer Down',
    undoable: true,
    execute: async (ctx: EditorContextValue): Promise<void> => {
      const { activeFrame, activeLayer, layers, actions } = ctx;
      if (!activeFrame || !activeLayer) return;

      const hostLayers = layers.getHostLayers(activeFrame.layers.order.map(id => activeFrame.layers.byId[id]));
      const activeIndex = hostLayers.findIndex(l => l.id === activeLayer.id);

      if (activeIndex === 0) {
        actions.setInteraction({ hud: { message: 'Cannot merge down. This is the bottom-most layer.', type: 'error' } });
        return;
      }

      const targetLayer = hostLayers[activeIndex - 1];


      try {
        const { asset: assetResult, bounds } = await compositeLayersToAsset(
          [targetLayer, activeLayer], ctx,
        );

        layers.updateLayer(activeFrame.id, (tx) => {
          tx.edit(targetLayer.id)
            .setAsset(assetResult)
            .resetWithBounds(bounds.w, bounds.h, bounds.cx, bounds.cy);
        });

        // Type inference after merging:
        // - paint + paint -> paint | text + text -> text | color + color -> paint
        // - craft mixing (any combination of paint/text/color) -> paint (the merged result is essentially bitmap drawing content)
        // - involving image -> image (degrades to a general bitmap)
        const isCraftLayer = (t: string) => t === 'paint' || t === 'text' || t === 'color';
        const bothCraft = isCraftLayer(activeLayer.type) && isCraftLayer(targetLayer.type);
        const mergedType = bothCraft
          ? (activeLayer.type === targetLayer.type && activeLayer.type !== 'color'
            ? activeLayer.type
            : 'paint')
          : 'image';

        actions.updateLayer(activeFrame.id, targetLayer.id, {
          type: mergedType,
          textData: undefined,
          bitmapMasks: [],
        });

        layers.removeLayers(activeFrame.id, activeLayer.id);
        layers.activate(activeFrame.id, targetLayer.id);

      } catch (err) {
        console.error('[LayerPanel] Merge down failed:', err);
        actions.setInteraction({ hud: { message: 'Merge down failed.', type: 'error' } });
      }
    }
  } as EditorCommand<void, Promise<void>>,

  mergeVisible: {
    id: P.ADV_LAYER_MERGE_VISIBLE,
    name: 'Merge Visible Layers',
    undoable: true,
    execute: async (ctx: EditorContextValue): Promise<void> => {
      const { activeFrame, layers, actions } = ctx;
      if (!activeFrame) return;

      const hostLayers = layers.getHostLayers(activeFrame.layers.order.map(id => activeFrame.layers.byId[id]));
      const visibleLayers = hostLayers.filter(l => l.visible);

      if (visibleLayers.length < 2) {
        actions.setInteraction({ hud: { message: 'Need at least 2 visible layers to merge.', type: 'error' } });
        return;
      }

      const targetLayer = visibleLayers[0];
      const items = visibleLayers.slice(1);

      try {
        const { asset: assetResult, bounds } = await compositeLayersToAsset(
          visibleLayers, ctx,
        );

        layers.updateLayer(activeFrame.id, (tx) => {
          tx.edit(targetLayer.id)
            .setAsset(assetResult)
            .resetWithBounds(bounds.w, bounds.h, bounds.cx, bounds.cy);
        });

        // Type inference after merging (consistent with mergeDown):
        // - all paint -> paint | all text -> text
        // - craft mixing (any combination of paint/text/color) -> paint
        // - involving image -> image (degrades to a general bitmap)
        const isCraftLayer = (t: string) => t === 'paint' || t === 'text' || t === 'color';
        const allCraft = visibleLayers.every(l => isCraftLayer(l.type));
        const allTypes = visibleLayers.map(l => l.type);
        const uniqueTypes = [...new Set(allTypes)];
        const mergedType: Layer['type'] = allCraft
          ? (uniqueTypes.length === 1 && uniqueTypes[0] !== 'color' ? uniqueTypes[0] as Layer['type'] : 'paint')
          : 'image';

        actions.updateLayer(activeFrame.id, targetLayer.id, {
          type: mergedType,
          textData: undefined,
          bitmapMasks: [],
        });

        // [Critical] Must batch-remove all items in a single call. React's useReducer
        // dispatch is async — getState() returns the same stale snapshot throughout a
        // command execution. If we remove items one-by-one, each removeLayers' cut-link
        // cleanup hook reads the same stale vectorMasks and the last write wins, leaving
        // residual hole masks on the source layer. The batch call's internal maskRemovalMap
        // correctly collects all masks and filters them in one operation.
        layers.removeLayers(activeFrame.id, items.map(item => item.id));

        layers.activate(activeFrame.id, targetLayer.id);

      } catch (err) {
        console.error('[LayerPanel] Merge visible failed:', err);
        actions.setInteraction({ hud: { message: 'Merge visible failed.', type: 'error' } });
      }
    }
  } as EditorCommand<void, Promise<void>>,

  rasterize: {
    id: P.ADV_LAYER_MERGE_RASTERIZE,
    name: 'Rasterize Layer',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload?: { layerId?: string }): Promise<void> => {
      const { activeFrame, layers, actions } = ctx;
      if (!activeFrame) return;

      const layerId = payload?.layerId || ctx.activeLayer?.id;
      if (!layerId) return;

      const layer = activeFrame.layers.byId[layerId];
      if (!layer) return;

      try {
        const { asset: assetResult, bounds } = await compositeLayersToAsset(
          [layer], ctx,
        );

        layers.updateLayer(activeFrame.id, (tx) => {
          tx.edit(layer.id)
            .setAsset(assetResult)
            .resetWithBounds(bounds.w, bounds.h, bounds.cx, bounds.cy);
        });

        // After rasterization, the layer becomes a pure bitmap — all non-destructive
        // effects (masks, adjustments) are now baked into the pixel data and must be
        // cleared to prevent double-application during rendering.
        actions.updateLayer(activeFrame.id, layer.id, {
          type: 'image',
          textData: undefined,
          bitmapMasks: [],
          vectorMasks: [],
          adjustments: undefined,
        });

      } catch (err) {
        console.error('[LayerPanel] Rasterize failed:', err);
        actions.setInteraction({ hud: { message: 'Rasterize failed.', type: 'error' } });
      }
    }
  } as EditorCommand<{ layerId?: string }, Promise<void>>,

  /**
   * mergeBack: Unified merge-back command — auto-detects layer role.
   *
   * - If layerId is a **cut fragment** (has sourceLayerId + assocMaskId):
   *   Recursively merges this fragment and all its downstream fragments back to the source.
   * - If layerId is a **source layer** (has hole masks with assocLayerId):
   *   Merges all direct fragments (and their downstream) back to this source.
   * - Otherwise: no-op.
   *
   * The recursive algorithm is the same in both cases — difference is only the entry point.
   * UI shows "Merge Back" on fragments and "Merge Fragments" on source layers,
   * both dispatch this same command.
   */
  mergeBack: {
    id: P.ADV_LAYER_MERGE_BACK,
    name: 'Merge Back',
    undoable: true,
    execute: (ctx: EditorContextValue, payload?: { layerId?: string }): void => {
      const { activeFrame, layers, actions } = ctx;
      if (!activeFrame) return;

      const layerId = payload?.layerId || ctx.activeLayer?.id;
      if (!layerId) return;

      const layer = activeFrame.layers.byId[layerId];
      if (!layer) return;

      // Snapshot all layers for downstream lookups (stable reference during recursion)
      const allLayers = activeFrame.layers.order.map(id => activeFrame.layers.byId[id]);

      /**
       * Two-phase merge-back algorithm to avoid stale-state issues.
       *
       * React's useReducer dispatch is async — getState() returns the same snapshot
       * throughout a single command execution. If we interleave reads and writes
       * (as the old per-iteration approach did), later reads see stale vectorMasks
       * and produce incorrect filtered results that overwrite earlier correct writes.
       *
       * Phase 1 (Collection): Recursively walks the fragment tree using the stale
       * snapshot (safe — tree structure is read-only). Collects:
       *   - All fragment IDs to delete
       *   - Per-source-layer: set of mask IDs to remove
       *
       * Phase 2 (Execution): Applies all mutations in batch:
       *   - Single updateLayer per source (filters ALL collected masks at once)
       *   - Single removeLayers for all collected fragments
       *
       * Example: A → B → D  (A cut to B, B cut to D)
       *   collectMergeBack('B') →
       *     finds D as downstream of B → collectMergeBack('D')
       *     collects: fragmentsToRemove=[D, B], maskRemovals={B: [mask-hole-D], A: [mask-hole-B]}
       *   Execute: remove masks from B and A, then delete [D, B]
       *   Result: only A remains, fully restored.
       */

      // ── Phase 1: Collection ──
      const fragmentsToRemove: string[] = [];
      const maskRemovalMap = new Map<string, Set<string>>(); // sourceLayerId → maskIds to remove

      function collectMergeBack(fragLayerId: string): void {
        const fragLayer = activeFrame!.layers.byId[fragLayerId];
        if (!fragLayer) return;

        // Find downstream cut fragments (depth-first: process children before parent)
        const downstreamFragments = allLayers.filter(l =>
          !l.hostId && l.metadata?.sourceLayerId === fragLayerId && l.metadata?.assocMaskId
        );
        for (const downstream of downstreamFragments) {
          collectMergeBack(downstream.id);
        }

        // Read this fragment's cut-link pointers
        const sourceId = fragLayer.metadata?.sourceLayerId as string | undefined;
        const maskId = fragLayer.metadata?.assocMaskId as string | undefined;
        if (!sourceId || !maskId) return;

        // Record fragment to delete (regardless of whether source still exists)
        fragmentsToRemove.push(fragLayerId);

        // Record mask to remove from source (skip if source was already deleted)
        const srcLayer = activeFrame!.layers.byId[sourceId];
        if (!srcLayer) return;
        if (!maskRemovalMap.has(sourceId)) maskRemovalMap.set(sourceId, new Set());
        maskRemovalMap.get(sourceId)!.add(maskId);
      }

      try {
        // ── Role detection ──
        const isCutFragment = !!(layer.metadata?.sourceLayerId && layer.metadata?.assocMaskId);
        const hasHoleMasks = !!(layer.vectorMasks?.some(m => m.assocLayerId));

        if (isCutFragment) {
          collectMergeBack(layerId);
        } else if (hasHoleMasks) {
          const directFragments = allLayers.filter(l =>
            !l.hostId && l.metadata?.sourceLayerId === layerId && l.metadata?.assocMaskId
          );
          for (const frag of directFragments) {
            collectMergeBack(frag.id);
          }
        }
        // else: no-op

        if (fragmentsToRemove.length === 0) return;

        // ── Phase 2: Batch execution ──
        // Remove all collected masks from each source layer (single write per source)
        for (const [sourceId, maskIds] of maskRemovalMap) {
          const srcLayer = activeFrame.layers.byId[sourceId];
          if (!srcLayer) continue;
          const updatedMasks = (srcLayer.vectorMasks || []).filter(m => !maskIds.has(m.id));
          actions.updateLayer(activeFrame.id, sourceId, { vectorMasks: updatedMasks });
        }

        // Delete all fragments in one batch (removeLayers handles triplet sub-layers internally)
        layers.removeLayers(activeFrame.id, fragmentsToRemove);

      } catch (err) {
        console.error('[MergeBack] Failed:', err);
        actions.setInteraction({ hud: { message: 'Merge Back failed.', type: 'error' } });
      }
    }
  } as EditorCommand<{ layerId?: string }, void>
};
