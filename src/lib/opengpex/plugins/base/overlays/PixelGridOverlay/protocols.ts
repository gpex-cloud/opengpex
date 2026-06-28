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

// ─── Cross-Plugin Typed Facade ──────────────────────────────────────────────────

/**
 * PixelGridOverlayAPI: Structured cross-plugin facade for external consumers.
 *
 * Usage:
 *   import { PixelGridOverlayAPI } from '../PixelGridOverlay/protocols';
 *   const gridConfig = state.pluginConfig[PixelGridOverlayAPI.configKey];
 */
export const PixelGridOverlayAPI = {
  /** pluginConfig storage key */
  configKey: `${PLUGIN_AUTHOR}.${PLUGIN_ID}` as const,
} as const;

