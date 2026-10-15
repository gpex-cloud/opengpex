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
 * Default minimum on-screen physical pixel size of one source/document pixel at
 * which the pixel grid becomes visible (GIMP-style criterion `p = camera.k×dpr
 * >= N`). `N = 12` shows the grid at ≈600% on a DPR=2 screen
 * (≈1200% on DPR=1) — in line with GIMP/Photoshop, without smearing lines into
 * a solid block. Consumed as the `initialConfig` default and the fallback when
 * `PixelGridConfig.minPixelSize` is absent.
 */
export const DEFAULT_MIN_PIXEL_SIZE = 12;

/**
 * Grid line rendering style.
 *
 *   • `'dual'`  — dark casing + light core, the background-agnostic pair.
 *     Only fits when a line has ≥2 device pixels; below
 *     {@link DUAL_TONE_MIN_DPR} the two tones would collapse into ONE
 *     twice-as-wide device pixel (the thick-grid artifact on 1080p-class
 *     displays), so the render path auto-degrades 'dual' to the light single
 *     line. The preference itself stays dual — drag the window to a Retina
 *     screen and the full pair returns, no setting change needed.
 *   • `'dark'`  — single dark hairline.
 *   • `'light'` — single light hairline.
 *
 * Single-tone hairlines are the PS/GIMP model: one line, user picks the tone
 * per content (they accept that a line can vanish against a matching
 * background; the 深/浅 switch is the escape hatch).
 */
export type GridLineStyle = 'dual' | 'dark' | 'light';

export const DEFAULT_LINE_STYLE: GridLineStyle = 'dual';

/**
 * devicePixelRatio floor under which the dual-tone pair no longer fits into
 * one line width: casing + core need ≥2 device pixels, and at DPR=1 a
 * 2-device-px casing reads ~2× wider than the Retina appearance the scheme
 * was tuned on. 1.5 puts fractional-DPR laptops (1.25) on the single-line
 * side and 4K@150% (1.5) on the dual side, where the casing is ~1.3 CSS px.
 */
export const DUAL_TONE_MIN_DPR = 1.5;

/**
 * Default grid line colors — dual-tone "casing" scheme.
 *
 * A single fixed color always fails against SOME background (white lines vanish
 * on light images, black lines vanish on dark ones). We draw each grid line
 * TWICE: a slightly wider dark `gridCasingColor` underneath (the outline/halo), then
 * a thin light `gridColor` core on top. On any background at least one tone stays
 * visible — no contrast blind spot. This mirrors the dual-path contrast technique
 * already used by ClipOverlay's marching ants (but here: static, solid lines).
 */
export const DEFAULT_GRID_COLOR = 'rgba(255, 255, 255, 0.23)';        // light core
export const DEFAULT_GRID_CASING_COLOR = 'rgba(0, 0, 0, 0.23)';      // dark casing/halo (subtle)

/**
 * Custom Config Interface
 */
export interface PixelGridConfig {
  enabled: boolean;
  hardEdge: boolean;
  /**
   * Minimum on-screen physical pixel size of one source/document pixel at which
   * the grid becomes visible (GIMP-style criterion `p >= N`).
   * Replaces the legacy `zoomThreshold` (absolute `camera.k`), which drifted
   * with image size / fit / DPR.
   */
  minPixelSize: number;
  /** Line rendering style (see {@link GridLineStyle}). */
  lineStyle: GridLineStyle;
  /** Light core line color (drawn on top of the casing). */
  gridColor: string;
  /** Dark casing/halo color (drawn wider, underneath the core) for contrast. */
  gridCasingColor: string;
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

