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

import * as DEFAULTS from './presets';
import { USER_ADJUSTABLE_KEYS, type UserAdjustableKey } from './whitelist';

// ─── Type Definitions ─────────────────────────────────────────────────────────

type PresetKeys = keyof typeof DEFAULTS;
type PresetValues = typeof DEFAULTS;

type Listener = <K extends PresetKeys>(key: K, value: PresetValues[K]) => void;

// ─── PresetsFactory ───────────────────────────────────────────────────────────

/**
 * Runtime-switchable preset store.
 *
 * Provides synchronous `get`/`set` for use in performance-critical paths
 * (e.g. wheel event handlers) and a `subscribe` API compatible with
 * React's `useSyncExternalStore` for reactive UI binding.
 *
 * Design invariants:
 * - `get()` is O(1), allocation-free — safe to call per-frame.
 * - Overrides layer on top of static defaults from `presets.ts`.
 * - Listeners are notified synchronously on `set`/`reset`.
 *
 * @see docs/opengpex/plans/20260805_windows_mouse_wheel_fix.md §PresetsFactory
 */
class PresetsFactory {
  private defaults: PresetValues;
  private overrides: Partial<PresetValues> = {};
  private listeners = new Set<Listener>();

  constructor(defaults: PresetValues) {
    this.defaults = defaults;
  }

  /** Synchronously retrieve the effective value (override > default). */
  get<K extends PresetKeys>(key: K): PresetValues[K] {
    return (key in this.overrides ? this.overrides[key] : this.defaults[key]) as PresetValues[K];
  }

  /** Runtime override (called by Settings UI / plugins). */
  set<K extends PresetKeys>(key: K, value: PresetValues[K]): void {
    this.overrides[key] = value;
    this.listeners.forEach(fn => fn(key, value));
  }

  /** Restore a key to its default value. */
  reset<K extends PresetKeys>(key: K): void {
    delete this.overrides[key];
    this.listeners.forEach(fn => fn(key, this.defaults[key]));
  }

  /** Subscribe to value changes (returns unsubscribe function). */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Export current overrides (for persistence to IndexedDB). */
  getOverrides(): Partial<PresetValues> {
    return { ...this.overrides };
  }

  /**
   * Export only user-adjustable overrides (filtered by whitelist).
   * Used by persistence layer — internal constants are never stored.
   */
  getAdjustableOverrides(): Partial<Pick<PresetValues, UserAdjustableKey>> {
    const result: Partial<Record<string, unknown>> = {};
    for (const key of USER_ADJUSTABLE_KEYS) {
      if (key in this.overrides) {
        result[key] = this.overrides[key];
      }
    }
    return result as Partial<Pick<PresetValues, UserAdjustableKey>>;
  }

  /** Restore overrides from persisted storage (call once at startup). */
  hydrate(saved: Partial<PresetValues>): void {
    // Only hydrate keys that exist in current defaults (guards against stale/removed keys)
    const filtered: Partial<PresetValues> = {};
    for (const key of Object.keys(this.defaults)) {
      if (key in saved) {
        (filtered as Record<string, unknown>)[key] = (saved as Record<string, unknown>)[key];
      }
    }
    this.overrides = filtered;
  }
}

// ─── Singleton Export ─────────────────────────────────────────────────────────

export const presets = new PresetsFactory(DEFAULTS);
