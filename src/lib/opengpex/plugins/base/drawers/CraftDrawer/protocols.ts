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
 * CraftDrawer Plugin Protocols
 *
 * Defines constants and type contracts for craft tool panel.
 * CraftDrawer is a unified sidebar panel for text/brush/eraser tools.
 */

export const PLUGIN_ID = 'drawers.craft_drawer';
export const PLUGIN_AUTHOR = 'opengpex';

// ─── Signal IDs ────────────────────────────────────────────────────────────────

/** Currently active craft tool (null = no active tool) */
export const SIGNAL_ACTIVE_CRAFT = 'signal.active_craft';

// ─── Command IDs ───────────────────────────────────────────────────────────────

export const CMD_SET_CRAFT = 'cmd.set_craft';
export const CMD_SET_CRAFT_TEXT = 'cmd.set_craft_text';
export const CMD_SET_CRAFT_BRUSH = 'cmd.set_craft_brush';
export const CMD_SET_CRAFT_ERASER = 'cmd.set_craft_eraser';
export const CMD_DEACTIVATE_CRAFT = 'cmd.deactivate_craft';

export const CMD_BRUSH_SIZE_UP = 'cmd.brush_size_up';
export const CMD_BRUSH_SIZE_DOWN = 'cmd.brush_size_down';
export const CMD_BRUSH_OPACITY_1 = 'cmd.brush_opacity_1';
export const CMD_BRUSH_OPACITY_2 = 'cmd.brush_opacity_2';
export const CMD_BRUSH_OPACITY_3 = 'cmd.brush_opacity_3';
export const CMD_BRUSH_OPACITY_4 = 'cmd.brush_opacity_4';
export const CMD_BRUSH_OPACITY_5 = 'cmd.brush_opacity_5';
export const CMD_BRUSH_OPACITY_6 = 'cmd.brush_opacity_6';
export const CMD_BRUSH_OPACITY_7 = 'cmd.brush_opacity_7';
export const CMD_BRUSH_OPACITY_8 = 'cmd.brush_opacity_8';
export const CMD_BRUSH_OPACITY_9 = 'cmd.brush_opacity_9';
export const CMD_BRUSH_OPACITY_0 = 'cmd.brush_opacity_0';

// ─── Cross-Plugin Constants (cross-plugin references) ───────────────────────────────────────

/** Cross-plugin config storage key: craft tool panel configuration */
export const CRAFT_DRAWER_CONFIG_KEY = `${PLUGIN_AUTHOR}.${PLUGIN_ID}`;

/** Cross-plugin signal storage key: currently active craft tool */
export const CRAFT_DRAWER_SIGNAL_ACTIVE_CRAFT = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_ACTIVE_CRAFT}`;

/** Cross-plugin command UID: deactivate current craft tool (called by external plugins like BrushOverlay / TextOverlay to exit) */
export const CRAFT_DRAWER_CMD_DEACTIVATE_CRAFT = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_DEACTIVATE_CRAFT}`;

// ─── Types ─────────────────────────────────────────────────────────────────────

export type CraftType = 'text' | 'brush' | 'eraser';
export type ActiveCraft = CraftType | null;

/** CraftDrawer plugin local configuration interface */
export interface CraftDrawerConfig {
  brushSize: number;
  brushOpacity: number;
  brushHardness: number;
}
