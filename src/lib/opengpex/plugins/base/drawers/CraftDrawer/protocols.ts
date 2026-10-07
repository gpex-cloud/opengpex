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

import { TEXT_LAYER_PADDING } from '@opengpex/editor/core/helpers/config';

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
export const CMD_SET_CRAFT_MARKER = 'cmd.set_craft_marker';
export const CMD_DEACTIVATE_CRAFT = 'cmd.deactivate_craft';

/** Marker sub-type cycling (Tab / Shift+Tab, mirrors ClipOptions.cycleToolForward/Backward) */
export const CMD_CYCLE_MARKER_FORWARD = 'cmd.cycle_marker_forward';
export const CMD_CYCLE_MARKER_BACKWARD = 'cmd.cycle_marker_backward';


export const CMD_BRUSH_SIZE_UP = 'cmd.brush_size_up';
export const CMD_BRUSH_SIZE_DOWN = 'cmd.brush_size_down';

export const CMD_BRUSH_OPACITY_UP = 'cmd.brush_opacity_up';
export const CMD_BRUSH_OPACITY_DOWN = 'cmd.brush_opacity_down';
export const CMD_SET_CRAFT_MOSAIC = 'cmd.set_craft_mosaic';

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

import type { MarkerKind, MarkerDataBase } from '@opengpex/editor/core/types';

export type CraftType = 'text' | 'brush' | 'eraser' | 'restore' | 'mosaic' | 'marker';
export type ActiveCraft = CraftType | null;

/** Pending text style preset (persisted across tool activations) */
export interface PendingTextData {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  align?: 'left' | 'center' | 'right';
  lineHeight?: number;
  letterSpacing?: number;
  verticalAlign?: 'top' | 'middle' | 'bottom';
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

/** CraftDrawer plugin local configuration interface */
export interface CraftDrawerConfig {
  brushSize: number;
  brushOpacity: number;
  brushHardness: number;
  /**
   * Eraser edge AA toggle (always visible in the eraser panel; two-way bound to
   * `brushHardness` — turning it on snaps hardness to 100, dragging hardness
   * below 100 turns it off). `false` routes `hard: true` into the eraser's
   * BitmapMask — the GPU thresholds the sampled mask alpha at 0.5 for a binary
   * "pencil eraser" edge. Omitted = AA on (the historical behaviour).
   */
  eraserAntiAliased?: boolean;
  /**
   * Brush (stroke paint tool) edge AA toggle — the BRUSH mode sibling of
   * `eraserAntiAliased`, always visible in the brush panel. Bound to
   * `brushHardness` in the OPPOSITE direction of the eraser: AA OFF ignores the
   * hardness feather entirely, so the pair is only self-consistent at
   * hardness = 100 (switching AA off snaps hardness to 100; dragging hardness
   * below 100 forces AA back on — a soft tip must be AA'd; switching AA on
   * leaves hardness untouched). `false` freezes `antiAliased: false` into the
   * stroke's `StrokeData` at pointerdown for a binary "pixel pencil" edge.
   * Omitted = AA on (the historical behaviour).
   */
  brushAntiAliased?: boolean;
  /** User-configured text style preset for next text layer creation */
  pendingTextData?: PendingTextData;
  /** Mosaic brush size preset */
  mosaicSizePreset: 'S' | 'M' | 'L' | 'XL';
  /** Active marker sub-type (persisted across tool switches; default resolves to first registered kind) */
  activeMarkerKind?: MarkerKind;
  /**
   * Pending marker style preset, persisted across tool activations and reused as
   * the style of the NEXT drawn marker. Carries stroke/fill (all kinds) plus an
   * optional cornerRadius (rect only — ignored by other kinds).
   */
  pendingMarkerData?: Partial<MarkerDataBase> & { cornerRadius?: number };
}

// ─── Mosaic Size Presets ───────────────────────────────────────────────────────

/** Preset sizes for mosaic tool (brushDiameter, blockSize) */
export const MOSAIC_SIZE_PRESETS = {
  S: { brushDiameter: 20, blockSize: 8 },
  M: { brushDiameter: 40, blockSize: 16 },
  L: { brushDiameter: 80, blockSize: 32 },
  XL: { brushDiameter: 160, blockSize: 64 },
} as const;

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

/** Line height used when the user has not chosen one (mirrors the layer default). */
export const TEXT_DEFAULT_LINE_HEIGHT = 1.4;

/**
 * Computes the initial inline text box size for a newly placed text layer.
 *
 * Height follows the font metrics (fontSize × lineHeight + vertical padding) so
 * the empty box hugs the first line at any canvas resolution. Width scales with
 * the font size and is capped to a fraction of the canvas width, so a 4K canvas
 * gets a proportionally usable input box instead of a fixed-pixel sliver.
 *
 * Shared by the place handler (initial layer bounding) and the inline editor
 * (CSS minWidth) so the two never disagree on the very first frame.
 */
export function getInitialTextBoxSize(
  fontSize: number,
  lineHeight: number,
  canvasW: number,
): { w: number; h: number } {
  const h = Math.ceil(fontSize * lineHeight) + TEXT_LAYER_PADDING.y * 2;
  const w = Math.round(Math.min(Math.max(fontSize * 5.6, 140), Math.max(140, canvasW * 0.42)));
  return { w, h };
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
