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
import { PreferencesPanel } from './components';
import { SlidersHorizontal } from 'lucide-react';
import * as P from './protocols';
import { initPresetsStorage } from './storage';

/**
 * Preferences Plugin: Settings UI for all user-adjustable core presets.
 *
 * Provides:
 * - PreferencesPanel contributed to SETTINGS_CONFIG_PANEL (order: 10 → first tab)
 * - Persistence: hydrates presets from localStorage on init, subscribes to
 *   changes for auto-save.
 *
 * Design principles:
 * - Single responsibility: UI for PresetsFactory overrides only.
 * - Extensible: Add new preset controls per domain group.
 * - Decoupled: Only depends on PresetsFactory (core infra), not other plugins.
 * - Removable: Embedded deployments can exclude this plugin; presets default.
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: 'Preferences',
    version: '1.0.0',
    description: 'Global editor behavior preferences.',
    category: 'xtends',
    author: P.PLUGIN_AUTHOR,
    requirements: { coreVersion: '>=1.0.0', auth: 'none' },
  },

  slot: 'HIDDEN',
  component: () => null,

  contributions: [
    {
      slot: 'SETTINGS_CONFIG_PANEL',
      group: 'preferences',
      component: PreferencesPanel,
      title: 'Preferences',
      icon: <SlidersHorizontal size={12} />,
      order: 10, // Ensures this tab appears first
    },
  ],

  /**
   * Lifecycle: Initialize persistence on plugin load.
   * Hydrates presets from localStorage and subscribes for auto-save.
   */
  onInit: () => {
    initPresetsStorage();
  },
};

export default plugin;
