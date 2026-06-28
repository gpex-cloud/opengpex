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

import { usePluginSelfConfig, usePluginCommands } from '@opengpex/editor/core/context';
import type { GpexHubPanelCommandsMap } from './commands.d';
import * as P from './protocols';

/**
 * useGpexHubConfig: Gets panel toggle and Tab status via usePluginSelfConfig,
 * gets toggle command handler via usePluginCommands.
 */
export const useGpexHubConfig = () => {
  const [selfConfig, setSelfConfig] = usePluginSelfConfig<P.GpexHubConfig>();
  const { toggleCmd } = usePluginCommands<GpexHubPanelCommandsMap>();

  const isOpen = selfConfig?.open === true;
  const activeTab = selfConfig?.activeTab ?? 'explore';
  const panelPosition = selfConfig?.panelPosition ?? 'CT';

  const toggle = () => toggleCmd?.execute();

  const setActiveTab = (tab: P.GpexHubConfig['activeTab']) => {
    setSelfConfig({ ...selfConfig, activeTab: tab });
  };

  return {
    isOpen,
    activeTab,
    panelPosition,
    toggle,
    setActiveTab,
  };
};
