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
import { normalizeMosaicMode } from '@opengpex/editor/plugins/base/overlays/RetouchOverlay/stroke/types';

// ─── useRetouchPanel ────────────────────────────────────────────────────────────

/**
 * useRetouchPanel: Semantic Hook for RetouchPanel mosaic attribute panel
 *
 * Provides read/write access to the retouch mode (whitelist-normalized —
 * a stale persisted value can never select an unknown mode), the size
 * preset, and the blur/sharpen convolution parameters.
 * Parameters are stored in pluginConfig['opengpex.drawers.craft_tools'].
 */
export function useRetouchPanel() {
  const [selfConfig, setSelfConfig] = usePluginSelfConfig<CraftDrawerConfig>();

  const sizePreset = selfConfig.mosaicSizePreset ?? 'M';
  const presetValues = MOSAIC_SIZE_PRESETS[sizePreset];
  // Custom diameter override (typed into the Diameter row): when set it wins
  // over the preset's brushDiameter and no preset tab is highlighted.
  const customDiameter = selfConfig.mosaicStampDiameter;
  const isCustomDiameter = customDiameter != null && customDiameter > 0;
  const stampDiameter = isCustomDiameter ? customDiameter : presetValues.brushDiameter;
  // Mosaic block size follows the diameter at the presets' ratio (d/2.5)
  // when custom, so the pixelation grid stays proportional.
  const blockSize = isCustomDiameter
    ? Math.max(2, Math.round(stampDiameter / 2.5))
    : presetValues.blockSize;
  const toolMode = normalizeMosaicMode(selfConfig.mosaicToolMode);
  const blurRadius = selfConfig.mosaicBlurRadius ?? 8;
  const blurStrength = selfConfig.mosaicBlurStrength ?? 60;
  const hardness = selfConfig.retouchHardness ?? 75;

  const setSizePreset = useCallback(
    (preset: 'XS' | 'S' | 'M' | 'L' | 'XL') => {
      // A preset click also clears any custom diameter override.
      setSelfConfig({ mosaicSizePreset: preset, mosaicStampDiameter: undefined } as Partial<CraftDrawerConfig>);
    },
    [setSelfConfig]
  );

  const setStampDiameter = useCallback(
    (diameter: number) => {
      setSelfConfig({ mosaicStampDiameter: Math.max(2, Math.min(400, Math.round(diameter) || 2)) } as Partial<CraftDrawerConfig>);
    },
    [setSelfConfig]
  );

  const setToolMode = useCallback(
    (mode: CraftDrawerConfig['mosaicToolMode']) => {
      setSelfConfig({ mosaicToolMode: mode } as Partial<CraftDrawerConfig>);
    },
    [setSelfConfig]
  );

  const setBlurRadius = useCallback(
    (radius: number) => {
      setSelfConfig({ mosaicBlurRadius: Math.max(1, Math.min(64, Math.round(radius) || 1)) } as Partial<CraftDrawerConfig>);
    },
    [setSelfConfig]
  );

  const setBlurStrength = useCallback(
    (strength: number) => {
      setSelfConfig({ mosaicBlurStrength: Math.max(0, Math.min(100, Math.round(strength) || 0)) } as Partial<CraftDrawerConfig>);
    },
    [setSelfConfig]
  );

  const setHardness = useCallback(
    (value: number) => {
      setSelfConfig({ retouchHardness: Math.max(0, Math.min(100, Math.round(value) || 0)) } as Partial<CraftDrawerConfig>);
    },
    [setSelfConfig]
  );

  return { sizePreset, presetValues, setSizePreset, toolMode, setToolMode, blurRadius, setBlurRadius, blurStrength, setBlurStrength, hardness, setHardness, stampDiameter, blockSize, isCustomDiameter, setStampDiameter };
}
