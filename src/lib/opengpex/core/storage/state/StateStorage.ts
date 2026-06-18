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

import { AssetService } from '@opengpex/editor/core/storage/asset/AssetService';
import { Hydrating } from './Hydrating';
import { ShardedStateDriver, StateDriver } from '@opengpex/editor/core/storage/Driver';
import { EditorData, Frame, GlobalHistoryState, UIConfig } from '@opengpex/editor/core/types';

/** Sharded structure of persistent project metadata */
interface ProjectMeta {
  frameIds: string[];
  activeFrameId: string | null;
  pluginConfig: Record<string, Record<string, unknown>>;
  ui: UIConfig;
}

/**
 * StateStorage: Persistence service dedicated to editor artboard states (JSON)
 */
export class StateStorage {
  // Artboard reference tracking in memory for $O(1)$ dirty checking
  private lastSavedFrameRefs = new Map<string, Frame>();

  constructor(private assets: AssetService) {}

  /**
   * Saves state to persistent medium (incremental sharded save)
   */
  async save(state: EditorData): Promise<void> {
    try {
      const updates: Record<string, unknown> = {};
      const frameIds: string[] = [];

      // 1. Physical dirty checking based on === references
      const dirtyFrames = state.frames.order.map(id => state.frames.byId[id]).filter(f => this.lastSavedFrameRefs.get(f.id) !== f);

      // 2. Dehydrate only dirty artboards, and write into shard in frame:{id} format
      await Promise.all(dirtyFrames.map(async f => {
        const dummyPool = {}; // Assets are independently persisted by AssetService
        const serialized = await Hydrating.dehydrateSingleFrame(f, this.actionsProxyForAssets(), dummyPool);
        updates[`frame:${f.id}`] = serialized;
        this.lastSavedFrameRefs.set(f.id, f); // Update cached reference
      }));

      // Build main index
      state.frames.order.forEach(id => frameIds.push(id));

      // 3. Dehydrate incremental history records (Patch-on-Disk)
      const dummyPoolHistory = {};
      const serializedHistory = await Hydrating.dehydrate(state.history, this.actionsProxyForAssets(), dummyPoolHistory);
      updates['history_index'] = serializedHistory;

      // 4. Update main config shard
      updates['project_meta'] = {
        frameIds,
        activeFrameId: state.activeFrameId,
        pluginConfig: state.pluginConfig,
        ui: state.ui,
        isLoaded: true
      };

      // 5. Call pseudo-transactional batch writing of the shard driver
      await ShardedStateDriver.setItems(updates);
    } catch (err) {
      console.error('[StateStorage] Save failed:', err);
    }
  }

  /**
   * Restores state from persistent medium
   */
  async restore(): Promise<EditorData | null> {
    try {
      // Attempt to read the new sharded format
      const meta = await StateDriver.getItem<ProjectMeta>('project_meta');
      
      if (meta) {
        const frameIds: string[] = meta.frameIds || [];
        const frames: Frame[] = [];
        
        // For now, read all frames to avoid breaking UI references; this can be optimized to Lazy Load later
        await Promise.all(frameIds.map(async id => {
          const frameData = await StateDriver.getItem<Frame>(`frame:${id}`);
          if (frameData) {
            frames.push(frameData);
          }
        }));

        const historyIndex = await StateDriver.getItem<GlobalHistoryState>('history_index');

        // Asset ignition
        const activeIds = new Set<string>();
        frames.forEach(f => Hydrating.extractAllIds(f, activeIds));
        if (historyIndex) Hydrating.extractAllIds(historyIndex, activeIds);
        
        await this.assets.hydrate(activeIds);

        // Recursive hydration
        const hydratedFrames = Hydrating.hydrate(frames, this.assets) as Frame[];
        const hydratedHistory = Hydrating.hydrate(historyIndex, this.assets) as GlobalHistoryState;

        // Reset dirty checking references
        this.lastSavedFrameRefs.clear();
        hydratedFrames.forEach(f => this.lastSavedFrameRefs.set(f.id, f));

        // Asynchronously initiate garbage shard collection
        setTimeout(() => this.auditOrphanShards(), 2000);

        return {
          frames: { byId: Object.fromEntries(hydratedFrames.map(f => [f.id, f])), order: hydratedFrames.map(f => f.id) },
          activeFrameId: meta.activeFrameId,
          history: hydratedHistory,
          pluginConfig: meta.pluginConfig,
          ui: meta.ui,
          isLoaded: true
        } as EditorData;
      }

      // If project metadata is not found, there is no restorable data
      return null;
    } catch (err) {
      console.error('[StateStorage] Restore failed:', err);
      return null;
    }
  }

  /**
   * Garbage collection: cleans up orphaned assets no longer referenced by any state
   */
  async gc(state: EditorData, force = false): Promise<void> {
    // 1. Scan active IDs in memory (including Frames, History, Clipboard)
    const activeIds = Hydrating.extractAllIds(state);
    
    // 2. Clean up physical assets in asset service
    this.assets.sweep(activeIds, force);
    console.log('[StateStorage] GC complete. Active assets:', activeIds.size, 'Force GC:', force);
  }

  /**
   * Cleans up unreferenced orphaned shards (Orphaned Shards) in database
   */
  async auditOrphanShards(): Promise<void> {
    try {
      const meta = await StateDriver.getItem<ProjectMeta>('project_meta');
      if (!meta) return;

      const validFrameKeys = new Set((meta.frameIds || []).map((id: string) => `frame:${id}`));
      validFrameKeys.add('project_meta');
      validFrameKeys.add('history_index');

      const keys = await StateDriver.keys();
      const keysToRemove = keys.filter(k => (k.startsWith('frame:') || k.startsWith('snapshot:')) && !validFrameKeys.has(k));

      if (keysToRemove.length > 0) {
        await ShardedStateDriver.removeItems(keysToRemove);
        console.log(`[StateStorage] Orphan GC: Removed ${keysToRemove.length} obsolete shards.`);
      }
    } catch (e) {
      console.error('[StateStorage] auditOrphanShards failed', e);
    }
  }

  /**
   * Clears all states and associated assets
   */
  async clear() {
    await StateDriver.clear();
    this.lastSavedFrameRefs.clear();
  }

  /**
   * Exports artboard to portable serialized form (dehydration + asset Blob collection)
   * No local persistence involved, for use by Advanced Command / external consumers.
   */
  async export(frame: Frame): Promise<{ state: unknown; assets: Record<string, Blob> }> {
    const assetsPool: Record<string, { blob: Blob }> = {};
    const state = await Hydrating.dehydrateSingleFrame(frame, this.assets, assetsPool);
    const assets: Record<string, Blob> = {};
    for (const [id, { blob }] of Object.entries(assetsPool)) {
      assets[id] = blob;
    }
    return { state, assets };
  }

  /**
   * Restores artboard from serialized form via hydration
   * Assumes assets are pre-injected into AssetService.
   */
  import(state: unknown): Frame {
    return Hydrating.hydrateSingleFrame(state, this.assets);
  }

  /**
   * Internal helper: adapts Assets interface needed by Hydrating
   */
  private actionsProxyForAssets() {
    return this.assets;
  }
}

/**
 * Factory function: creates StateStorage instance
 */
export const createStateStorage = (assets: AssetService) => new StateStorage(assets);
