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
import { SmartGuides, SmartGuidesToggle } from './components';
import { SmartGuidesSettings } from './panels/settings';
import { SMART_GUIDES_COMMANDS } from './commands';
import { Magnet } from 'lucide-react';
import * as P from './protocols';

/**
 * SmartGuides Plugin: Provides viewport alignment guides (Pure view layer).
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: 'Smart Guides',
    version: '1.0.0',
    description: 'Provides alignment assistance between layers and canvas edges.',
    category: 'overlays',
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: '>=1.0.0',
      auth: 'none'
    }
  },
  slot: 'VIEWPORT_OVERLAY',
  show: 'frame-required',
  component: SmartGuides,
  initialConfig: {
    enabled: true,
    snapToCanvas: true,
    snapToBirth: true,
    snapToLayers: true,
    excludeLayerTypes: [],
    ignoreLockedLayers: true,
    ignoreSmallLayers: true,
    smallLayerThreshold: 400,
    maxSnapTargets: 8,
    edgeSnapScope: 'recanvas'
  },
  commands: Object.values(SMART_GUIDES_COMMANDS),
  contributions: [
    {
      slot: 'TOOL_MENU',
      component: SmartGuidesToggle,
      order: 2010
    },
    {
      slot: 'SETTINGS_CONFIG_PANEL',
      group: 'Smart Guides',
      component: SmartGuidesSettings,
      title: 'Smart Guides',
      icon: <Magnet size={12} />,
      order: 200
    }
  ]
};

export default plugin;
