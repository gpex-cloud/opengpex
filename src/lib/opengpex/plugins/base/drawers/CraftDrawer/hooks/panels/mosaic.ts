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

import { useCallback } from 'react';
import { usePluginSelfConfig } from '@opengpex/editor/core/context';
import { MOSAIC_SIZE_PRESETS } from '../../protocols';
import { CraftDrawerConfig } from '../../protocols';

// ─── useMosaicPanel ────────────────────────────────────────────────────────────

/**
 * useMosaicPanel: Semantic Hook for MosaicPanel mosaic attribute panel
 *
 * Provides ability to read and write mosaic size preset.
 * Parameters are stored in pluginConfig['opengpex.drawers.craft_tools'].
 */
export function useMosaicPanel() {
  const [selfConfig, setSelfConfig] = usePluginSelfConfig<CraftDrawerConfig>();

  const sizePreset = selfConfig.mosaicSizePreset ?? 'M';
  const presetValues = MOSAIC_SIZE_PRESETS[sizePreset];

  const setSizePreset = useCallback(
    (preset: 'XS' | 'S' | 'M' | 'L' | 'XL') => {
      setSelfConfig({ mosaicSizePreset: preset } as Partial<CraftDrawerConfig>);
    },
    [setSelfConfig]
  );

  return { sizePreset, presetValues, setSizePreset };
}
