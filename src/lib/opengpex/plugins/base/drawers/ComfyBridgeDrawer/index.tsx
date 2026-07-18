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

import { EditorPlugin } from '@opengpex/editor/core/types';
import { Link } from 'lucide-react';
import { ComfyBridgeDrawer } from './components';
import { ComfyBridgeSettings } from './settings';
import { COMFY_BRIDGE_COMMANDS } from './commands';
import { ComfyBridgeIcon } from './icon';
import * as P from './protocols';

export const plugin: EditorPlugin = {
  // --- 1. Identity ---
  manifest: {
    id: P.PLUGIN_ID,
    displayName: 'Comfy Bridge',
    version: '1.0.0',
    description:
      'Connect to your local ComfyUI instance for advanced AI image generation and processing.',
    author: P.PLUGIN_AUTHOR,
    category: 'drawers',
    requirements: {
      coreVersion: '>=1.0.0',
      auth: 'none',
    },
  },

  // --- 2. UI Entry ---
  icon: <ComfyBridgeIcon />,
  slot: 'SIDE_BAR',
  order: 2200,
  // show: 'frame-required',

  // --- 3. Core Implementation ---
  component: ComfyBridgeDrawer,

  // --- 4. Initial Config ---
  initialConfig: P.DEFAULT_COMFY_CONFIG as unknown as Record<string, unknown>,

  // --- 5. Commands ---
  commands: Object.values(COMFY_BRIDGE_COMMANDS),

  // --- 6. Contributions ---
  contributions: [
    {
      slot: 'SETTINGS_CONFIG_PANEL',
      group: 'Comfy Bridge',
      component: ComfyBridgeSettings,
      title: 'Connect to ComfyUI Services',
      icon: <Link size={12} />,
      order: 330,
    },
  ],
};
