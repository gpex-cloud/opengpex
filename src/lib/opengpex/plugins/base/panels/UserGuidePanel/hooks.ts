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

import { useMemo, useSyncExternalStore } from 'react';
import { usePluginSelfConfig, usePluginCommands, usePluginSignals, useEditorServices } from '@opengpex/editor/core/context';
import { BuiltCommand } from '@opengpex/editor/core/types';
import type { UserGuidePanelCommandsMap, UserGuidePanelSignalsMap } from './commands.d';
import * as P from './protocols';

export interface GroupedCategory {
  category: string;
  commands: BuiltCommand[];
}

/**
 * useUserGuide: Unified user guide panel state bridging hook
 */
export const useUserGuide = () => {
  const [selfConfig] = usePluginSelfConfig<P.GuideConfig>();
  const { toggleCmd } = usePluginCommands<UserGuidePanelCommandsMap>();
  const { openSignal } = usePluginSignals<UserGuidePanelSignalsMap>();
  const { plugins } = useEditorServices();

  // Subscribe to changes in the plugins store so that we reactively compute the data when plugins/commands register
  const allCommandsSnapshot = useSyncExternalStore(
    plugins.subscribe,
    () => plugins.getAllCommands(),
    () => plugins.getAllCommands()
  );

  const isActive = !!openSignal?.value;

  const pluginTabsData = useMemo(() => {
    void allCommandsSnapshot;
    const allPlugins = plugins.getAllPlugins();
    const groups: Record<string, GroupedCategory> = {};

    allPlugins.forEach(p => {
      const cmdsWithShortcuts = p.commands?.filter(c => c.shortcut || c.shortcuts) || [];
      if (cmdsWithShortcuts.length === 0) return;

      const rawCat = p.manifest?.category || 'General';
      const catName = rawCat.charAt(0).toUpperCase() + rawCat.slice(1).toLowerCase();

      if (!groups[catName]) {
        groups[catName] = { category: catName, commands: [] };
      }
      cmdsWithShortcuts.forEach(c => {
        if (!groups[catName].commands.some(x => x.uid === c.uid)) {
          groups[catName].commands.push(c);
        }
      });
    });

    return Object.values(groups).sort((a, b) => a.category.localeCompare(b.category));
  }, [plugins, allCommandsSnapshot]);

  const advancedTabsData = useMemo(() => {
    void allCommandsSnapshot;
    const allPlugins = plugins.getAllPlugins();
    const allPluginCommandUids = new Set(
      allPlugins.flatMap(p => p.commands?.map(cmd => cmd.uid || `${p.uid}.${cmd.id}`) || [])
    );
    const advancedCommands = plugins.getAllCommands().filter(c => 
      (c.shortcut || c.shortcuts) && (c.uid.startsWith('adv.') || c.uid.startsWith('cmd.')) && !allPluginCommandUids.has(c.uid)
    );

    const groups: Record<string, GroupedCategory> = {};

    advancedCommands.forEach(c => {
      const parts = c.uid.split('.');
      let xxx = parts[0] === 'adv' || parts[0] === 'cmd' ? parts[1] : parts[0];
      if (xxx === 'layer_panel') {
        xxx = 'layer';
      }
      const category = xxx ? (xxx.charAt(0).toUpperCase() + xxx.slice(1)) : 'General';

      if (!groups[category]) {
        groups[category] = { category, commands: [] };
      }
      if (!groups[category].commands.some(x => x.uid === c.uid)) {
        groups[category].commands.push(c);
      }
    });

    return Object.values(groups).sort((a, b) => a.category.localeCompare(b.category));
  }, [plugins, allCommandsSnapshot]);

  return {
    isActive,
    panelPosition: selfConfig?.panelPosition ?? 'BR',
    toggleCmd,
    pluginTabsData,
    advancedTabsData,
    getShortcutLabels: plugins.getShortcutLabels,
  };
};
