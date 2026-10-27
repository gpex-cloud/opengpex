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
export const CMD_SET_CRAFT_MARKER = 'cmd.set_craft_marker';
export const CMD_DEACTIVATE_CRAFT = 'cmd.deactivate_craft';

/** Marker sub-type cycling (Tab / Shift+Tab, mirrors ClipOptions.cycleToolForward/Backward) */
export const CMD_CYCLE_MARKER_FORWARD = 'cmd.cycle_marker_forward';
export const CMD_CYCLE_MARKER_BACKWARD = 'cmd.cycle_marker_backward';
/** Set the active marker sub-type directly (used when entering the tool from an existing marker layer). */
export const CMD_SET_MARKER_KIND = 'cmd.set_marker_kind';


export const CMD_BRUSH_SIZE_UP = 'cmd.brush_size_up';
export const CMD_BRUSH_SIZE_DOWN = 'cmd.brush_size_down';

export const CMD_BRUSH_OPACITY_UP = 'cmd.brush_opacity_up';
export const CMD_BRUSH_OPACITY_DOWN = 'cmd.brush_opacity_down';
export const CMD_SET_CRAFT_MOSAIC = 'cmd.set_craft_mosaic';
export const CMD_SET_CRAFT_PEN = 'cmd.set_craft_pen';

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
    /** Activate the text tool (no-op toggle risk: callers must guard against already-active) */
    activateText: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_SET_CRAFT_TEXT}` } as { uid: string; _payload: void },
    /** Activate the marker tool (same toggle semantics as activateText: guard against already-active) */
    activateMarker: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_SET_CRAFT_MARKER}` } as { uid: string; _payload: void },
    /** Set the active marker sub-type (unknown kinds are ignored) */
    setMarkerKind: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_SET_MARKER_KIND}` } as { uid: string; _payload: { kind: MarkerKind } },
    /** Activate the pen tool (same toggle semantics as activateText: guard against already-active) */
    activatePen: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_SET_CRAFT_PEN}` } as { uid: string; _payload: void },
  },
  /** pluginConfig storage key */
  configKey: `${PLUGIN_AUTHOR}.${PLUGIN_ID}` as const,
} as const;

// ─── Types ─────────────────────────────────────────────────────────────────────

import type { MarkerDataBase, MarkerKind } from '../../overlays/MarkerOverlay/marker/types';

export type CraftType = 'text' | 'brush' | 'eraser' | 'restore' | 'mosaic' | 'marker' | 'pen';
export type ActiveCraft = CraftType | null;

/**
 * One saved brush preset: a named snapshot of the brush parameter set the
 * brush panel exposes. Applied wholesale by the presets UI.
 */
export interface BrushPreset {
  id: string;
  name: string;
  size: number;
  opacity: number;
  hardness: number;
  antiAliased: boolean;
  stabilizer: number;
  pressureOpacity: boolean;
  taper: number;
  /** Per-end taper snapshots; falling back to taper for pre-split presets. */
  taperStart?: number;
  taperEnd?: number;
  velocity: boolean;
}

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
   * `brushHardness`, same direction as the brush — turning it OFF snaps hardness
   * to 100, dragging hardness below 100 turns it back ON). `false` routes
   * `hard: true` into the eraser's BitmapMask — the GPU thresholds the sampled
   * mask alpha at 0.5 for a binary, idempotent "pencil eraser" edge. AA on with
   * hardness < 100 = soft feathered erasing (the historical behaviour).
   * Omitted = AA on.
   */
  eraserAntiAliased?: boolean;
  /**
   * Brush (stroke paint tool) edge AA toggle — the brush-mode sibling of
   * `eraserAntiAliased`, always visible in the brush panel. Bound to
   * `brushHardness` in the SAME direction as the eraser: AA OFF ignores the
   * hardness feather entirely, so the pair is only self-consistent at
   * hardness = 100 (switching AA off snaps hardness to 100; dragging hardness
   * below 100 forces AA back on — a soft tip must be AA'd; switching AA on
   * leaves hardness untouched). `false` freezes `antiAliased: false` into the
   * stroke's `StrokeData` at pointerdown for a binary "pixel pencil" edge.
   * Omitted = AA on (the historical behaviour).
   */
  brushAntiAliased?: boolean;
  /**
   * Rope-model stabilizer slack in SCREEN px (0 = off, 100 = very steady).
   * The rope point chases the pointer and only moves the slack excess, so
   * hand tremor inside the slack never enters the stroke; dividing by the
   * camera zoom at sample time keeps the felt smoothness zoom-independent.
   * Omitted = off.
   */
  brushStabilizer?: number;
  /**
   * Pen pressure → per-point ink opacity (pressure-opacity dynamics). The
   * WIDTH lane always follows pressure; this toggle additionally multiplies
   * the same effective pressure into each sample's ALPHA lane. Omitted = off.
   */
  brushPressureOpacity?: boolean;
  /**
   * Stroke start/end taper (calligraphic entry/exit) as a percentage of the
   * tip diameter — the per-end arc-length zone that ramps pressure 0→1.
   * Omitted = off.
   */
  brushTaper?: number;
  /** Per-end taper overrides (0..100); falling back to brushTaper when omitted. */
  brushTaperStart?: number;
  brushTaperEnd?: number;
  /** Start/End sliders move together (default true). */
  brushTaperLink?: boolean;

  /**
   * Velocity dynamics (fast-thin / slow-thick): pointer speed above a
   * reference thins the stroke, down to a fixed floor. Omitted = off.
   */
  brushVelocity?: boolean;
  /**
   * Saved brush presets (F7): a named snapshot of the full brush parameter
   * set (size/opacity/hardness/AA + the four dynamics knobs). Persisted like
   * the other brush parameters.
   */
  brushPresets?: BrushPreset[];
  /** User-configured text style preset for next text layer creation */
  pendingTextData?: PendingTextData;
  /** Mosaic brush size preset */
  mosaicSizePreset: 'S' | 'M' | 'L' | 'XL';
  /** Active marker sub-type (persisted across tool switches; default resolves to first registered kind) */
  activeMarkerKind?: MarkerKind;
  /**
   * Feather radius preset (px, 0-100) for the pen tool's "Apply as Mask"
   * commit. Persisted across tool activations like the brush parameters.
   */
  penFeather?: number;
  /**
   * Anchor budget for "Apply as Bezier" (selection → pen draft). One of the
   * four fixed detents 100/200/300/400 — the fit tolerance adapts until the
   * converted draft stays within the budget, so dense AI contours (thousands
   * of vertices) never explode into an uneditable, frame-dropping anchor
   * count. Persisted like the other pen presets.
   */
  penAnchorBudget?: number;
  /** Last-used pen shape-layer style (persisted across sessions like the marker pending style). */
  penFillHex?: string;
  penStrokeHex?: string;
  penStrokeWidth?: number;
  /**
   * Legacy single pending marker style. Kept only as the fallback for kinds that
   * have no entry in `pendingMarkerByKind` yet; never written any more.
   */
  pendingMarkerData?: PendingMarkerStyle;
  /**
   * Per-kind pending marker style, persisted across tool activations and reused
   * as the style of the NEXT drawn marker of that kind. Each kind remembers its
   * own stroke/fill (+ cornerRadius where the kind has one), so arming the star
   * tool never shows or edits the arrow's colours.
   */
  pendingMarkerByKind?: Partial<Record<MarkerKind, PendingMarkerStyle>>;
}

/**
 * Style subset a pending (not yet drawn) marker remembers per kind: stroke/fill
 * (all kinds) plus the kind-specific knobs that have panel controls
 * (cornerRadius for rect/callout, sides for polygon, points for star).
 */
export type PendingMarkerStyle = Partial<MarkerDataBase> & {
  cornerRadius?: number;
  sides?: number;
  points?: number;
};

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

/** Static fallback for the marker stroke-width slider max when no canvas is open. */
const MARKER_STROKE_STATIC_MAX = 50;

/**
 * Dynamic slider maximum for the marker stroke width, by canvas size — the
 * same idea as `getDynamicTextSizeMax`: a 50 px ceiling is plenty on a 1000 px
 * screenshot but invisible on a 6000 px photo, while a fixed large ceiling
 * makes the slider too coarse on small images.
 *
 * Rules:
 * - Always >= 50
 * - For large canvases, 5% of the canvas short side, rounded UP to a multiple
 *   of 5 (3042 px → 155, 3140 px → 160)
 * - Hard cap at ABSOLUTE_MARKER_STROKE_MAX
 */
export function getDynamicMarkerStrokeMax(canvasW?: number, canvasH?: number): number {
  if (!canvasW || !canvasH) return MARKER_STROKE_STATIC_MAX;
  const shortSide = Math.min(canvasW, canvasH);
  // Round UP to a multiple of 5 so the ceiling reads as a tidy number
  // (3042 px → 152.1 → 155, not 152).
  const scaled = Math.ceil((shortSide * 0.05) / MARKER_STROKE_MAX_STEP) * MARKER_STROKE_MAX_STEP;
  return Math.min(ABSOLUTE_MARKER_STROKE_MAX, Math.max(MARKER_STROKE_STATIC_MAX, scaled));
}

/** The dynamic ceiling snaps up to this granularity. */
const MARKER_STROKE_MAX_STEP = 5;

/** Absolute maximum for the stroke-width number input (regardless of slider range). */
export const ABSOLUTE_MARKER_STROKE_MAX = 400;

/** Minimum font size constant */
export const TEXT_SIZE_MIN = 6;
