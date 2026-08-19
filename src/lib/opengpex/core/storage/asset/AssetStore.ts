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

import { TileMetadata } from '@opengpex/editor/core/types';
import { AssetDriver } from '@opengpex/editor/core/storage/Driver';

export const ASSET_VERSION = 2; // Current metadata version

/** Key prefix for high-resolution raw source blobs (16-bit fidelity) */
const RAW_KEY_PREFIX = 'raw:';

export interface StoredAsset {
  id: string;
  blob: Blob;
  tileMeta: TileMetadata;
  timestamp: number;
  version?: number;
}

/**
 * AssetStore: Persistent asset store based on Driver (LocalForage)
 * Responsibility: Responsible for physically saving assets to IndexedDB.
 *
 * Supports associated high-resolution raw blobs stored under `raw:${assetId}`
 * keys for 16-bit fidelity export (lossless round-trip).
 */
export class AssetStore {
  /**
   * Returns all keys in the asset store (for GC raw orphan scanning).
   */
  async keys(): Promise<string[]> {
    return AssetDriver.keys();
  }

  /**
   * Clears all assets
   */
  async clear(): Promise<void> {
    await AssetDriver.clear();
  }

  /**
   * Saves asset
   */
  async set(id: string, blob: Blob, tileMeta: TileMetadata): Promise<void> {
    const data: StoredAsset = { id, blob, tileMeta, timestamp: Date.now(), version: ASSET_VERSION };
    await AssetDriver.setItem(id, data);
  }

  /**
   * Checks if asset exists in physical storage (O(1) preflight check, without reading Blob)
   */
  async has(id: string): Promise<boolean> {
    const keys = await AssetDriver.keys();
    return keys.includes(id);
  }

  /**
   * Gets specified asset
   */
  async get(id: string): Promise<StoredAsset | null> {
    return AssetDriver.getItem<StoredAsset>(id);
  }

  /**
   * Gets all assets
   */
  async getAll(): Promise<StoredAsset[]> {
    const assets: StoredAsset[] = [];
    await AssetDriver.iterate<StoredAsset, void>((value) => {
      assets.push(value);
    });
    return assets;
  }

  /**
   * Deletes specified display asset from physical storage.
   */
  async remove(id: string): Promise<void> {
    await AssetDriver.removeItem(id);
  }

  // ─── Raw Source Storage ─────────────────────────────────────────────────

  /**
   * Stores a high-resolution raw source blob associated with an asset.
   * Used for 16-bit TIFF/PNG/RAW imports and original GIF files to preserve
   * original data for lossless re-export.
   * The raw blob is stored in the same IDB but under a `raw:${id}` key.
   */
  async setRaw(id: string, rawBlob: Blob): Promise<void> {
    await AssetDriver.setItem(`${RAW_KEY_PREFIX}${id}`, rawBlob);
  }

  /**
   * Retrieves the high-resolution raw source blob for an asset.
   * Returns null if no raw source exists (8-bit source or pixel-edited asset).
   */
  async getRaw(id: string): Promise<Blob | null> {
    return AssetDriver.getItem<Blob>(`${RAW_KEY_PREFIX}${id}`);
  }

  /**
   * Checks whether a high-resolution raw source exists for the given asset.
   * Used by the export path to determine if 16-bit export is available.
   */
  async hasRaw(id: string): Promise<boolean> {
    const keys = await AssetDriver.keys();
    return keys.includes(`${RAW_KEY_PREFIX}${id}`);
  }

  /**
   * Deletes a raw source blob by its hash.
   * Called by GC sweep when raw:${hash} is no longer referenced by any frame.
   */
  async removeRaw(id: string): Promise<void> {
    await AssetDriver.removeItem(`${RAW_KEY_PREFIX}${id}`);
  }
}

/**
 * Export singleton for internal use by AssetService
 */
export const assetStore = new AssetStore();
