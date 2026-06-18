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
 */
export class AssetStore {
  /**
   * Saves asset
   */
  async set(id: string, blob: Blob, tileMeta: TileMetadata): Promise<void> {
    const data: StoredAsset = { 
      id, 
      blob, 
      tileMeta, 
      timestamp: Date.now(),
      version: ASSET_VERSION 
    };
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
   * Deletes specified asset
   */
  async remove(id: string): Promise<void> {
    await AssetDriver.removeItem(id);
  }

  /**
   * Clears all assets
   */
  async clear(): Promise<void> {
    await AssetDriver.clear();
  }
}

/**
 * Export singleton for internal use by AssetService
 */
export const assetStore = new AssetStore();
