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

import { useSyncExternalStore } from 'react';
import { presets } from './index';
import type * as DEFAULTS from './presets';

type PresetKeys = keyof typeof DEFAULTS;
type PresetValues = typeof DEFAULTS;

/**
 * React hook that subscribes to a single preset key.
 *
 * Uses `useSyncExternalStore` so the component re-renders only when
 * the specific key changes — no unnecessary updates for unrelated keys.
 *
 * @example
 * ```tsx
 * const scrollMode = usePreset('VIEWPORT_SCROLL_MODE');
 * ```
 */
export function usePreset<K extends PresetKeys>(key: K): PresetValues[K] {
  return useSyncExternalStore(
    (onStoreChange) => presets.subscribe((changedKey) => {
      if ((changedKey as string) === key) onStoreChange();
    }),
    () => presets.get(key),
    () => presets.get(key) // SSR fallback
  );
}
