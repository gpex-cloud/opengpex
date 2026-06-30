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
 * Signals
 *
 * SIGNAL_FORCE_SHOW_TYPES: When set (via `setStateSignal`), forces LayerOverlay
 * to show outlines for all layers whose `type` is in the provided array,
 * regardless of hover/active state or showAlways config. This enables other
 * plugins (e.g. TextOverlay) to request persistent visibility for specific
 * layer types without coupling LayerOverlay to their internal state.
 *
 * Value: string[] (e.g. ['text']) or null to clear.
 */
export const SIGNAL_FORCE_SHOW_TYPES = 'layer_overlay.force_show_types';

/**
 * Cross-plugin Reference UIDs
 */
export const LAYER_OVERLAY_CMD_TOGGLE = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_TOGGLE}`;
