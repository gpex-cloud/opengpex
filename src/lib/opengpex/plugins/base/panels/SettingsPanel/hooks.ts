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

import { usePluginSelfConfig, usePluginCommands, usePluginSignals } from '@opengpex/editor/core/context';
import type { SettingsPanelCommandsMap, SettingsPanelSignalsMap } from './commands.d';
import * as P from './protocols';

/**
 * useSettingsPanel: Unified settings panel state bridging hook
 * Encapsulates destructuring details of underlying commands and signals, providing high-semantic API to UI layer.
 */
export const useSettingsPanel = () => {
  const [selfConfig] = usePluginSelfConfig<P.SettingsConfig>();
  const { toggleCmd } = usePluginCommands<SettingsPanelCommandsMap>();
  const { openSignal, tabSignal } = usePluginSignals<SettingsPanelSignalsMap>();

  const isActive = !!openSignal?.value;
  const activeTabId = typeof tabSignal?.value === 'string' ? tabSignal.value : undefined;

  return {
    isActive,
    activeTabId,
    panelPosition: selfConfig?.panelPosition ?? 'CT',
    toggleCmd,
    tabSignal,
  };
};
