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

import { presets } from '@opengpex/editor/core/helpers/preferences';
import { STORAGE_KEY_PRESETS_OVERRIDES } from './protocols';

/**
 * PresetsStorage: Persistence integration for PresetsFactory overrides.
 *
 * Uses localStorage for synchronous hydrate at startup. This is critical
 * because `presets.get('VIEWPORT_SCROLL_MODE')` is called synchronously
 * inside wheel event handlers — before any async IndexedDB read could
 * complete.
 *
 * Trade-offs vs IndexedDB:
 * - ✅ Synchronous read at startup (no flicker / race condition)
 * - ✅ Simple (no driver/instance setup)
 * - ⚠️ ~5MB limit (more than enough for presets JSON)
 * - ⚠️ Cleared by "Clear Site Data" (acceptable for preferences)
 *
 * Flow:
 * 1. On init: read persisted overrides → hydrate into PresetsFactory
 * 2. On change: subscribe to PresetsFactory → write back to localStorage
 */

let initialized = false;

/**
 * Initialize presets persistence.
 * Safe to call multiple times — only the first call takes effect.
 */
export function initPresetsStorage(): void {
  if (initialized) return;
  initialized = true;

  // ─── 1. Hydrate: restore overrides from localStorage ────────────────────
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PRESETS_OVERRIDES);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        presets.hydrate(saved);
      }
    }
  } catch (err) {
    console.warn('[PresetsStorage] Failed to hydrate presets from localStorage:', err);
  }

  // ─── 2. Subscribe: auto-save on every change ───────────────────────────
  presets.subscribe(() => {
    try {
      const overrides = presets.getAdjustableOverrides();
      // Only persist if there are actual user-adjustable overrides
      if (Object.keys(overrides).length > 0) {
        localStorage.setItem(STORAGE_KEY_PRESETS_OVERRIDES, JSON.stringify(overrides));
      } else {
        localStorage.removeItem(STORAGE_KEY_PRESETS_OVERRIDES);
      }
    } catch (err) {
      console.warn('[PresetsStorage] Failed to persist presets:', err);
    }
  });
}
