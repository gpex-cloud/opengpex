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
 * TabDock Plugin Protocols
 */
export const PLUGIN_ID = 'overlays.tab_dock';
export const PLUGIN_AUTHOR = 'opengpex';

/**
 * Custom Config Interface
 */
export interface TabDockConfig {
  orientation: 'horizontal' | 'vertical';
  snap: string; // TL, TC, TR, ML, MC, MR, BL, BC, BR
  showProps: boolean;
  indentBranches: boolean;
  position?: { x: number; y: number };
}

/**
 * Command IDs
 */
export const CMD_UPDATE_CONFIG = 'cmd.config.update';
export const CMD_NEXT_FRAME = 'cmd.nav.next';
export const CMD_PREV_FRAME = 'cmd.nav.prev';
export const CMD_OPEN_SETTINGS = 'cmd.open_settings';

