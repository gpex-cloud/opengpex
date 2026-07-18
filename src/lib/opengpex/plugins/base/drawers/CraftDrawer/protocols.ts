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

export const PLUGIN_ID = 'drawers.craft_tools';
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

export type CraftType = 'text' | 'brush' | 'eraser' | 'restore';
export type ActiveCraft = CraftType | null;

/** Pending text style preset (persisted across tool activations) */
export interface PendingTextData {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  align?: 'left' | 'center' | 'right';
  lineHeight?: number;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

/** CraftDrawer plugin local configuration interface */
export interface CraftDrawerConfig {
  brushSize: number;
  brushOpacity: number;
  brushHardness: number;
  /** User-configured text style preset for next text layer creation */
  pendingTextData?: PendingTextData;
}

// ─── Text Size Adaptive Utilities ──────────────────────────────────────────────

/**
 * Reference font size calculation constants.
 * Strategy: use a percentage of the canvas short side, clamped to a reasonable range.
 */
const REF_RATIO = 0.04;    // 4% of canvas short side
const REF_MIN = 18;         // Minimum reference value (floor for tiny canvases)
const REF_MAX = 200;        // Maximum reference value (cap to avoid overly large initial size)

/**
 * Snaps a raw font size value to a "nice" number for better UX.
 * Rounding thresholds:
 *   ≥ 100 → snap to nearest 10 (100, 110, 120, ...)
 *    ≥ 50 → snap to nearest 5  (50, 55, 60, ...)
 *     < 50 → snap to nearest even number (18, 20, 22, 24, ...)
 */
function snapToNiceSize(raw: number): number {
  if (raw >= 100) return Math.round(raw / 10) * 10;
  if (raw >= 50) return Math.round(raw / 5) * 5;
  return Math.round(raw / 2) * 2;
}

/**
 * Computes a resolution-adaptive reference font size based on canvas dimensions.
 *
 * Formula: fontSize = snapToNice(clamp(shortSide × RATIO, MIN, MAX))
 *
 * Examples:
 *   800×600   → 24px (web-level)
 *   1920×1080 → 44px (presentation-level)
 *   3024×4032 → 120px (photography-level)
 *   530×530   → 22px (small canvas)
 *   300×300   → 18px (floor)
 */
export function getReferenceFontSize(canvasW: number, canvasH: number): number {
  const shortSide = Math.min(canvasW, canvasH);
  const raw = Math.max(REF_MIN, Math.min(REF_MAX, shortSide * REF_RATIO));
  return snapToNiceSize(raw);
}

/**
 * Static fallback for slider max when canvas dimensions are unavailable.
 */
const TEXT_SIZE_STATIC_MAX = 200;

/**
 * Computes a dynamic slider maximum for text size based on canvas dimensions.
 *
 * Rules:
 * - Always >= 200 (ensures basic usability)
 * - For large canvases, expands to 50% of the canvas short side
 *   (e.g. 3000px canvas → max=1500)
 * - Hard cap at 2000 (prevents extreme edge cases)
 */
export function getDynamicTextSizeMax(canvasW?: number, canvasH?: number): number {
  if (!canvasW || !canvasH) return TEXT_SIZE_STATIC_MAX;
  const shortSide = Math.min(canvasW, canvasH);
  return Math.min(2000, Math.max(TEXT_SIZE_STATIC_MAX, Math.round(shortSide * 0.5)));
}

/** Absolute maximum for number input (regardless of slider range) */
export const ABSOLUTE_TEXT_SIZE_MAX = 2000;

/** Minimum font size constant */
export const TEXT_SIZE_MIN = 6;
