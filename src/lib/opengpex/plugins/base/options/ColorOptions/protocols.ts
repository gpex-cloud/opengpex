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

export const PLUGIN_ID = 'options.color_options';
export const PLUGIN_AUTHOR = 'opengpex';

export const CMD_FILL_AS_LAYER = 'cmd.fill_as_layer';

/** Contribution slot: tool trigger button injection slot (contributed by plugins like CraftDrawer) */
export const COLOR_OPTIONS_CRAFT_SLOT = 'COLOR_OPTIONS_CRAFT_SLOT';

/** Cross-plugin config storage key: color configuration */
export const COLOR_OPTIONS_CONFIG_KEY = `${PLUGIN_AUTHOR}.${PLUGIN_ID}`;

export interface ColorOptionsConfig {
  pendingColor: string;
}
