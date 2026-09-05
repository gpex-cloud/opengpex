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

import { useMemo } from 'react';
import { usePluginCommands } from '@opengpex/editor/core/context';
import { usePreset } from '@opengpex/editor/core/helpers/preferences/usePreset';
import type { SmartGuidesCommandsMap } from './commands.d';

/**
 * useSmartGuides: Unified hook for smart guides (enable-state observation + commands).
 *
 * NOTE: this hook deliberately does NOT expose guide geometry. Live guide data
 * lives in `volatile.transient.smartguides` and is consumed at 30Hz by
 * `useSmartGuidesFastSync`, which writes straight to the DOM — routing it through
 * React would defeat the fast path. (A `state.interaction.smartguides` slow-state
 * field used to exist but was never written after the volatile migration; it and
 * the dead `isVisible` branch here were removed.)
 */
export const useSmartGuides = () => {
  const isEnabled = usePreset('SNAP_ENABLED');
  const { toggleCmd } = usePluginCommands<SmartGuidesCommandsMap>();

  return useMemo(() => ({
    isEnabled,
    toggleCmd,
  }), [isEnabled, toggleCmd]);
};
