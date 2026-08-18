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

import { EditorContextValue, EditorCommand } from '@opengpex/editor/core/types';
import { SettingsPanelAPI } from '../../panels/SettingsPanel/protocols';
import { presets } from '@opengpex/editor/core/helpers/preferences';
import * as P from './protocols';

/**
 * SMART_GUIDES_COMMANDS: Declarative command configurations (Single Source of Truth).
 */
export const SMART_GUIDES_COMMANDS = {
  toggle: {
    id: P.CMD_TOGGLE,
    name: 'Toggle Smart Guides',
    category: 'View',
    execute: (_ctx: EditorContextValue) => {
      const current = presets.get('SNAP_ENABLED');
      presets.set('SNAP_ENABLED', !current);
    },
    shortcut: { key: ';', meta: true, shift: true }
  } as EditorCommand<void, void>,

  openSettings: {
    id: P.CMD_OPEN_SETTINGS,
    name: 'Smart Guides Settings',
    category: 'View',
    execute: (ctx: EditorContextValue) => {
      // Open settings panel and navigate to the Guides tab
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.open, true);
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.tab, 'Smart Guides');
    },
    shortcut: { key: ';', meta: true }
  } as EditorCommand<void, void>
};
