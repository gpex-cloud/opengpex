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

/**
 * SettingsPanel Plugin Protocols
 */
export const PLUGIN_ID = 'panels.settings_panel';
export const PLUGIN_AUTHOR = 'opengpex';

/**
 * Custom Config Interface
 */
export interface SettingsConfig {
  panelPosition: 'BR' | 'BL' | 'CT' | 'AN';
}

/**
 * Command IDs
 */
export const CMD_TOGGLE = 'cmd.toggle';

/**
 * Signal IDs
 */
export const SIGNAL_OPEN = 'signal.open';
export const SIGNAL_TAB = 'signal.tab';

/**
 * Cross-plugin reference UIDs (for external consumer usage)
 *
 * Usage:
 *   import { SettingsPanelAPI } from '../../panels/SettingsPanel/protocols';
 *   ctx.actions.setStateSignal(SettingsPanelAPI.signals.open, true);
 *   ctx.actions.setStateSignal(SettingsPanelAPI.signals.tab, 'API Keys');
 *   actions.executeCommand(SettingsPanelAPI.commands.toggle.uid);
 */
export const SettingsPanelAPI = {
  signals: {
    /** Panel open state (boolean) */
    open: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_OPEN}` as const,
    /** Active tab name (string | null) */
    tab: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_TAB}` as const,
  },
  commands: {
    /** Toggle settings panel visibility */
    toggle: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_TOGGLE}` } as { uid: string; _payload: void },
  },
  /** pluginConfig storage key */
  configKey: `${PLUGIN_AUTHOR}.${PLUGIN_ID}` as const,
} as const;
