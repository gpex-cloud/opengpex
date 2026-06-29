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

import { FontDriver } from '@opengpex/editor/core/storage/Driver';

export const FONT_STORE_VERSION = 1;

export interface StoredFont {
  family: string;           // e.g. "Noto Sans SC"
  blob: Blob;              // WOFF2 binary data
  format: 'woff2' | 'woff' | 'truetype';
  weights: number[];       // e.g. [400, 700]
  unicodeRange?: string;   // e.g. "U+4E00-9FFF" (CJK subset)
  timestamp: number;       // Last used time (for GC)
  version: number;         // Schema version
}

/**
 * FontStore: Persistent font store based on FontDriver (LocalForage / IndexedDB)
 * Responsibility: Physically saving font binary data to IndexedDB for offline use and fast restoration.
 *
 * Follows the same pattern as AssetStore in core/storage/asset/AssetStore.ts
 */
export class FontStore {
  /**
   * Saves font binary + metadata to IndexedDB
   */
  async set(family: string, blob: Blob, meta: Omit<StoredFont, 'family' | 'blob' | 'timestamp' | 'version'>): Promise<void> {
    const data: StoredFont = {
      family,
      blob,
      ...meta,
      timestamp: Date.now(),
      version: FONT_STORE_VERSION,
    };
    await FontDriver.setItem(family, data);
  }

  /**
   * Gets specified font from IndexedDB
   */
  async get(family: string): Promise<StoredFont | null> {
    return FontDriver.getItem<StoredFont>(family);
  }

  /**
   * Checks if font exists in physical storage
   */
  async has(family: string): Promise<boolean> {
    const keys = await FontDriver.keys();
    return keys.includes(family);
  }

  /**
   * Removes specified font from IndexedDB
   */
  async remove(family: string): Promise<void> {
    await FontDriver.removeItem(family);
  }

  /**
   * Gets all cached fonts
   */
  async getAll(): Promise<StoredFont[]> {
    const fonts: StoredFont[] = [];
    await FontDriver.iterate<StoredFont, void>((value) => {
      fonts.push(value);
    });
    return fonts;
  }

  /**
   * GC: Remove fonts not used in N days
   * @param maxAgeDays Maximum age in days before a font is eligible for garbage collection
   * @returns Array of removed font family names
   */
  async gc(maxAgeDays = 30): Promise<string[]> {
    const threshold = Date.now() - maxAgeDays * 86400_000;
    const removed: string[] = [];
    await FontDriver.iterate<StoredFont, void>((value, key) => {
      if (value.timestamp < threshold) removed.push(key);
    });
    await Promise.all(removed.map(k => FontDriver.removeItem(k)));
    return removed;
  }

  /**
   * Clears all cached fonts
   */
  async clear(): Promise<void> {
    await FontDriver.clear();
  }
}

/**
 * Export singleton for internal use by FontService
 */
export const fontStore = new FontStore();
