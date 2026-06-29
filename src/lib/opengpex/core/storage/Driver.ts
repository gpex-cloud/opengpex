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

import localforage from 'localforage';

/**
 * Driver: Physical storage driver
 * Provides multiple isolated instances to ensure different types of data do not interfere with each other.
 */

// 1. State driver (stores artboard JSON state)
export const StateDriver = localforage.createInstance({
  name: 'OpenGPEX',
  storeName: 'State_V1'
});

// 2. Asset driver (stores binary image Blob)
export const AssetDriver = localforage.createInstance({
  name: 'OpenGPEXAssets',
  storeName: 'Assets_V2'
});

// 3. Font driver (stores WOFF2 binary font data)
export const FontDriver = localforage.createInstance({
  name: 'OpenGPEXFonts',
  storeName: 'Fonts_V1'
});

/**
 * Sharded state driver: Wraps StateDriver, providing pseudo-transactional batch write and delete capabilities
 */
export const ShardedStateDriver = {
  ...StateDriver,

  /**
   * Batch writes multiple key-values, attempting rollbacks on failure
   */
  async setItems(record: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(record);
    const originalValues: Record<string, unknown> = {};

    // 1. Backup original values for rollback
    try {
      await Promise.all(keys.map(async key => {
        const val = await StateDriver.getItem(key);
        if (val !== null) originalValues[key] = val;
      }));
    } catch (e) {
      console.warn('[ShardedStateDriver] Failed to backup for transaction rollback', e);
    }

    // 2. Attempt batch writing
    try {
      await Promise.all(keys.map(key => StateDriver.setItem(key, record[key])));
    } catch (err) {
      console.error('[ShardedStateDriver] setItems failed, attempting rollback...', err);
      // 3. Rollback
      await Promise.all(keys.map(key => {
        if (originalValues[key] !== undefined) {
          return StateDriver.setItem(key, originalValues[key]);
        } else {
          return StateDriver.removeItem(key);
        }
      }));
      throw err;
    }
  },

  /**
   * Batch deletes multiple key-values
   */
  async removeItems(keys: string[]): Promise<void> {
    await Promise.all(keys.map(key => StateDriver.removeItem(key)));
  }
};
