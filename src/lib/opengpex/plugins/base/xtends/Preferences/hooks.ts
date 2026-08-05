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

import { useCallback } from 'react';
import { presets } from '@opengpex/editor/core/helpers/preferences';
import { usePreset } from '@opengpex/editor/core/helpers/preferences/usePreset';
import type * as DEFAULTS from '@opengpex/editor/core/helpers/preferences/presets';

type PresetKeys = keyof typeof DEFAULTS;
type PresetValues = typeof DEFAULTS;

/**
 * usePresetToggle: Convenience hook for toggling between two preset values.
 *
 * Returns the current value and a toggle callback. Useful for binary/enum
 * preferences rendered as a SegmentedControl or Switch.
 *
 * @example
 * ```tsx
 * const [mode, setMode] = usePresetToggle('VIEWPORT_SCROLL_MODE');
 * // mode: 'legacy' | 'modern'
 * // setMode('modern') — instantly updates PresetsFactory + triggers re-render
 * ```
 */
export function usePresetToggle<K extends PresetKeys>(key: K): [PresetValues[K], (value: PresetValues[K]) => void] {
  const current = usePreset(key);

  const setValue = useCallback((value: PresetValues[K]) => {
    presets.set(key, value);
  }, [key]);

  return [current, setValue];
}
