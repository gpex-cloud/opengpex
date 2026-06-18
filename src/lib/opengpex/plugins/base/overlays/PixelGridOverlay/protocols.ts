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
 * PixelGridOverlay Plugin Protocols
 */
export const PLUGIN_ID = 'overlays.pixel_grid_overlay';
export const PLUGIN_AUTHOR = 'opengpex';

/** Cross-plugin config storage key: pixel grid configuration */
export const PIXEL_GRID_CONFIG_KEY = `${PLUGIN_AUTHOR}.${PLUGIN_ID}`;

/**
 * Custom Config Interface
 */
export interface PixelGridConfig {
  enabled: boolean;
  hardEdge: boolean;
  zoomThreshold: number;
  color: string;
}

/**
 * Command IDs
 */
export const CMD_TOGGLE = 'cmd.toggle';
export const CMD_HARD_EDGE_TOGGLE = 'cmd.hardedge.toggle';

