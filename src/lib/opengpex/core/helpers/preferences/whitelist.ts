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

import type * as DEFAULTS from './presets';

// ─── UI Control Types ─────────────────────────────────────────────────────────

export type PresetControlType =
  | 'switch'      // Boolean toggle (renders Switch component)
  | 'select'      // Dropdown / segmented control (renders Select or SegmentedControl)
  | 'slider'      // Numeric range (renders Slider)
  | 'number';     // Numeric input (renders NumberInput)

// ─── Preset Manifest Entry ────────────────────────────────────────────────────

export interface PresetManifestEntry<K extends keyof typeof DEFAULTS = keyof typeof DEFAULTS> {
  /** Preset key name (must match a key in presets.ts) */
  key: K;
  /** Display group (used as section heading in the Preferences panel) */
  group: string;
  /** Lucide icon name for the group heading (optional, first entry in group wins) */
  groupIcon?: string;
  /** Primary label shown next to the control */
  label: string;
  /** Secondary description text (concise explanation of the setting) */
  description?: string;
  /** Dynamic description: function that returns description based on current value */
  descriptionFn?: (value: unknown) => string;
  /** UI control type to render */
  control: PresetControlType;
  /**
   * For 'switch' type: defines what values ON/OFF map to.
   * - `onValue`: value when switch is ON
   * - `offValue`: value when switch is OFF
   * If omitted, defaults to `true`/`false` (boolean switch).
   */
  switchMap?: { onValue: unknown; offValue: unknown };
  /**
   * For 'select' type: available options.
   * Each option has a `value` (written to the preset) and a `label` (displayed).
   */
  options?: Array<{ value: unknown; label: string }>;
  /**
   * For 'slider'/'number' type: numeric constraints.
   */
  range?: { min: number; max: number; step?: number };
  /** Sort order within the group (lower = higher). Defaults to 0. */
  order?: number;
}

// ─── Preset Manifest ──────────────────────────────────────────────────────────
//
// The SINGLE SOURCE OF TRUTH for user-adjustable presets.
//
// To add a new user-adjustable preset:
//   1. Add an entry to PRESET_MANIFEST below
//   2. Done! The Preferences panel renders it automatically.
//
// The whitelist (USER_ADJUSTABLE_KEYS), type (UserAdjustableKey), and UI
// rendering are all derived from this manifest — no other file edits needed.
// ──────────────────────────────────────────────────────────────────────────────

export const PRESET_MANIFEST: PresetManifestEntry[] = [
  {
    key: 'VIEWPORT_SCROLL_MODE',
    group: 'Navigation',
    groupIcon: 'Mouse',
    label: 'Legacy Mode',
    descriptionFn: (value) =>
      value === 'legacy'
        ? 'Scroll = Pan, Ctrl/Alt+Scroll = Zoom'
        : 'Scroll = Zoom, Ctrl+Scroll = Pan',
    description: 'Legacy mode uses scroll-to-pan. Turn off for scroll-to-zoom.',
    control: 'switch',
    switchMap: { onValue: 'legacy', offValue: 'modern' },
    order: 0,
  },

  // ─── Future examples (uncomment when ready to expose) ────────────────────
  //
  // {
  //   key: 'VIEWPORT_FIT_PADDING',
  //   group: 'Navigation',
  //   groupIcon: 'Mouse',
  //   label: 'Fit-to-View Padding',
  //   description: 'Padding (in pixels) around the canvas when using Fit to View.',
  //   control: 'slider',
  //   range: { min: 0, max: 100, step: 5 },
  //   order: 10,
  // },
];

// ─── Derived Exports ──────────────────────────────────────────────────────────

/**
 * Whitelist of preset keys that users can modify through the Preferences panel.
 * Automatically derived from PRESET_MANIFEST — do not edit manually.
 */
export const USER_ADJUSTABLE_KEYS = PRESET_MANIFEST.map(e => e.key) as unknown as readonly (keyof typeof DEFAULTS)[];

/**
 * Union type of all user-adjustable preset key names.
 * Used to type-restrict persistence logic.
 */
export type UserAdjustableKey = (typeof PRESET_MANIFEST)[number]['key'] & keyof typeof DEFAULTS;

/**
 * Type-level check: all manifest entries must reference valid keys of the DEFAULTS module.
 * This produces a compile error if any entry in PRESET_MANIFEST has a key that
 * doesn't exist in presets.ts — catching typos at build time.
 */
type _ValidateKeys = (typeof PRESET_MANIFEST)[number]['key'] extends keyof typeof DEFAULTS ? true : never;
const _typeCheck: _ValidateKeys = true;
