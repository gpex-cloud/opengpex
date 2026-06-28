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

export const CMD_BRUSH_OPACITY_UP = 'cmd.brush_opacity_up';
export const CMD_BRUSH_OPACITY_DOWN = 'cmd.brush_opacity_down';
export const CMD_BRUSH_HARDNESS_UP = 'cmd.brush_hardness_up';
export const CMD_BRUSH_HARDNESS_DOWN = 'cmd.brush_hardness_down';

// ─── Cross-Plugin Typed Facade ──────────────────────────────────────────────────

/**
 * CraftDrawerAPI: Structured cross-plugin facade for external consumers.
 *
 * Usage:
 *   import { CraftDrawerAPI } from '../../drawers/CraftDrawer/protocols';
 *   state.interaction.signals[CraftDrawerAPI.signals.activeCraft];
 *   actions.executeCommand(CraftDrawerAPI.commands.deactivate.uid);
 */
export const CraftDrawerAPI = {
  signals: {
    /** Currently active craft tool (null = no active tool) */
    activeCraft: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_ACTIVE_CRAFT}` as const,
  },
  commands: {
    /** Deactivate current craft tool */
    deactivate: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_DEACTIVATE_CRAFT}` } as { uid: string; _payload: void },
  },
  /** pluginConfig storage key */
  configKey: `${PLUGIN_AUTHOR}.${PLUGIN_ID}` as const,
} as const;

// ─── Types ─────────────────────────────────────────────────────────────────────

export type CraftType = 'text' | 'brush' | 'eraser';
export type ActiveCraft = CraftType | null;

/** CraftDrawer plugin local configuration interface */
export interface CraftDrawerConfig {
  brushSize: number;
  brushOpacity: number;
  brushHardness: number;
}
