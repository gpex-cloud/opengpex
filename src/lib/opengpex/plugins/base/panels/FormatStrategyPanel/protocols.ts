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

/**
 * FormatStrategyPanel Plugin Protocols
 */
export const PLUGIN_ID = 'panels.format_strategy_panel';
export const PLUGIN_AUTHOR = 'opengpex';

/**
 * Command IDs
 */
export const CMD_TOGGLE = 'cmd.toggle';

/**
 * Custom Config Interface
 */
export interface FormatStrategyPluginConfig {
  enabled: boolean;
}

/** Filter value for one ingest decision axis: a concrete axis value or 'any' (no filtering). */
export type AxisFilter<T> = T | 'any';
