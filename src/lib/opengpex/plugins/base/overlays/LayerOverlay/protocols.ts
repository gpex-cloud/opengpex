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
 * LayerOverlay Plugin Protocols
 */
export const PLUGIN_ID = 'overlays.layer_overlay';
export const PLUGIN_AUTHOR = 'opengpex';

/**
 * Custom Config Interface
 */
export interface LayerOverlayConfig {
  showAlways: boolean;
}

/**
 * Commands
 */
export const CMD_TOGGLE = 'cmd.toggle';

/**
 * Cross-plugin Reference UIDs
 */
export const LAYER_OVERLAY_CMD_TOGGLE = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_TOGGLE}`;
