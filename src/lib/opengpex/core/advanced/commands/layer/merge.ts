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
import { EditorActions } from '@opengpex/editor/core/types';

/**
 * removeSourceHoles — remove the given hole masks from one source layer in a
 * SINGLE atomic write. Callers collect the mask set on their (stale) command
 * snapshot first; this function only performs the authoritative write. No
 * activation, no HUD, no fragment deletion — those stay with the caller
 * (mergeBack loops this once per source before its single batch delete).
 */
function removeSourceHoles(
  actions: EditorActions,
  frameId: string,
  sourceLayer: Layer,
  maskIds: ReadonlySet<string>,
): void {
  const remaining = (sourceLayer.vectorMasks ?? []).filter(m => !maskIds.has(m.id));
  actions.updateLayer(frameId, sourceLayer.id, { vectorMasks: remaining });
}

/**
 * Module-level reentry guard for the WHOLE merge family: while any one merge
 * command is executing, every other merge dispatch is void, not queued. All
 * commands read the same stale command snapshot, and the bake routes are
 * asynchronous with fire-and-forget callers — two concurrent merges would
 * compose on stale layer tables (resurrecting deleted participants, writing
 * back over rewritten layers). The lock makes such dispatches no-ops; it
 * lives outside the render tree on purpose, same adjudication rule as the
 * peel settle lock.
 */
let mergeInFlight = false;

function acquireMergeLock(): boolean {
  if (mergeInFlight) return false;
  mergeInFlight = true;
  return true;
}

function releaseMergeLock(): void {
  mergeInFlight = false;
}

/** Test isolation only: forces the merge lock open between tests. */
export function resetMergeLockForTests(): void {
  mergeInFlight = false;
}

interface MergeSelectedPayload {
  layerIds: string[];
}

/**
 * LayerMergeCommands: Advanced layer merge commands.
 *
 * v2: All merge / rasterize operations composite through
 * the SINGLE WebGPU RenderGraph via `pixels.render.compositeLayers()`. There is
 * no backend selection any more — the internal composite assembles a synthetic
 * ROI-box frame, reuses the same `layer.assetId` residency the preview warmed,
 * runs the identical compile + `RenderGraph.composite` path as `render()`, then
 * reads back a `CompositedImage` (plain-data bitmap). Composite pixels ≡ preview
 * pixels for the same layer subset (see CompositeDispatcher one-pipeline note).
 *
 * These commands only CONSUME the result: `assets.storeBundle()` registers the
 * bitmap (auto cache-warm via AssetService hooks) and `bounds` drives `resetWithBounds`.
 *
 * Precision: the product bit depth follows the participating
 * layers' highest source bit depth. That is resolved centrally in
 * `PixelFacade.compositeLayers` (the central bake-precision rule), so these
 * call-sites need not pass `precision` explicitly.
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

      // Restricted union merge: the participant set is fixed to the adjacent
      // pair (target below, active layer), ordered bottom to top.
      const targetLayer = hostLayers[activeIndex - 1];
      const participants = [targetLayer, activeLayer];

      // One merge at a time document-wide (see the family lock above).
      if (!acquireMergeLock()) return;
      try {
        // The shared merge entry: the pair bakes into the bottom layer.
        await layers.mergeLayers(activeFrame, participants, { errorHud: 'Merge down failed.' });
      } finally {
        releaseMergeLock();
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

      // Groups are not participants of a visible merge: they are containers
      // with no pixels, and treating one as a participant would DELETE it
      // (non-bottom) or overwrite it with a bitmap (bottom), orphaning its
      // children. Filter them out — the group and its structure stay intact.
      const mergeable = visibleLayers.filter(l => l.type !== 'group');
      if (mergeable.length < 2) {
        actions.setInteraction({ hud: { message: 'Need at least 2 visible layers to merge.', type: 'error' } });
        return;
      }
      if (!acquireMergeLock()) return;
      try {
        await layers.mergeLayers(activeFrame, mergeable, {
          errorHud: 'Merge visible failed.',
        });
      } catch (err) {
        console.error('[LayerPanel] Merge visible failed:', err);
        actions.setInteraction({ hud: { message: 'Merge visible failed.', type: 'error' } });
      } finally {
        releaseMergeLock();
      }
    }
  } as EditorCommand<void, Promise<void>>,

  /**
   * mergeSelected: merges the user-marked N-layer selection. Refusal HUD
   * and bake execution live in the layer service (`layers.mergeLayers`):
   * the set composites as seen into the bottom participant, and group /
   * fewer-than-two sets are refused with the resolver's HUD. The command
   * only guards its payload and serializes reentries.
   */
  mergeSelected: {
    id: P.ADV_LAYER_MERGE_SELECTED,
    name: 'Merge Selected Layers',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload?: MergeSelectedPayload): Promise<void> => {
      const { activeFrame, layers, actions } = ctx;
      if (!activeFrame || !payload?.layerIds || payload.layerIds.length < 2) return;
      if (!acquireMergeLock()) return;

      try {
        const participants = payload.layerIds
          .map(id => activeFrame.layers.byId[id])
          .filter(Boolean) as Layer[];

        if (participants.length < 2) {
          actions.setInteraction({ hud: { message: 'Need at least 2 valid layers to merge.', type: 'error' } });
          return;
        }

        await layers.mergeLayers(activeFrame, participants, { physicalSuccessHud: `Merged ${participants.length} layers.` });
      } finally {
        releaseMergeLock();
      }
    }
  } as EditorCommand<MergeSelectedPayload, Promise<void>>,

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
        // Shared bake primitive (services/baking.ts): composite → register → warm.
        const bake = await layers.bakeToAsset(activeFrame, [layer]);

        layers.updateLayer(activeFrame.id, (tx) => {
          tx.edit(layer.id)
            .setAsset({ assetId: bake.assetId, url: bake.url })
            .resetWithBounds(bake.bounds.w, bake.bounds.h, bake.bounds.x + bake.bounds.w / 2, bake.bounds.y + bake.bounds.h / 2);
        });

        // After rasterization, the layer becomes a pure bitmap — all non-destructive
        // effects (masks, adjustments) are now baked into the pixel data and must be
        // cleared to prevent double-application during rendering.
        actions.updateLayer(activeFrame.id, layer.id, {
          type: 'image',
          textData: undefined,
          bitmapMasks: [],
          vectorMasks: [],
          adjustMasks: undefined,
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
        // Remove all collected masks from each source layer via the shared
        // primitive (single atomic write per source, stale snapshot).
        for (const [sourceId, maskIds] of maskRemovalMap) {
          const srcLayer = activeFrame.layers.byId[sourceId];
          if (!srcLayer) continue;
          removeSourceHoles(actions, activeFrame.id, srcLayer, maskIds);
        }

        // Delete all fragments in one batch (removeLayers handles triplet
        // sub-layers internally). The holes were removed above; touch no
        // mask — a plain delete would rewrite them from this snapshot,
        // unlinked.
        layers.removeLayers(activeFrame.id, fragmentsToRemove, { cutLinks: 'ignore-link' });

      } catch (err) {
        console.error('[MergeBack] Failed:', err);
        actions.setInteraction({ hud: { message: 'Merge Back failed.', type: 'error' } });
      }
    }
  } as EditorCommand<{ layerId?: string }, void>
};
