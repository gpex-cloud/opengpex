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

import { EditorPlugin } from '@opengpex/editor/core/types';
import { TAB_DOCK_COMMANDS } from './commands';
import { TabDockComponent, TabDockSettings } from './components';
import { Monitor } from 'lucide-react';
import * as P from './protocols';

/**
 * TabDock Plugin: Provide multi-frame management container and global viewport controls.
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: 'Tab Dock',
    version: '1.0.0',
    description: 'Manage multi-frame workspaces with thumbnail previews, fast switching, and global viewport controls.',
    category: 'overlays',
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: '>=1.0.0',
      auth: 'none'
    }
  },
  slot: 'DOCK',
  show: 'frame-required',
  component: TabDockComponent,
  order: 10,
  commands: Object.values(TAB_DOCK_COMMANDS),
  initialConfig: {
    orientation: 'horizontal',
    snap: 'BC',
    showProps: true,
    indentBranches: true,
    showMetricsHud: true,
  },
  contributions: [
    {
      slot: 'SETTINGS_CONFIG_PANEL',
      component: TabDockSettings,
      title: 'Viewport',
      icon: <Monitor size={12} />,
      order: 100
    }
  ]
};

export default plugin;
