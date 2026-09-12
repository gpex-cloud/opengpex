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
 * Default grid line colors — dual-tone "casing" scheme (§ pixel-grid contrast).
 *
 * A single fixed color always fails against SOME background (white lines vanish
 * on light images, black lines vanish on dark ones). We draw each grid line
 * TWICE: a slightly wider dark `casingColor` underneath (the outline/halo), then
 * a thin light `color` core on top. On any background at least one tone stays
 * visible — no contrast blind spot. This mirrors the dual-path contrast technique
 * already used by ClipOverlay's marching ants (but here: static, solid lines).
 */
export const DEFAULT_GRID_COLOR = 'rgba(255, 255, 255, 0.8)';         // light core
export const DEFAULT_GRID_CASING_COLOR = 'rgba(0, 0, 0, 0.14)';      // dark casing/halo (subtle)

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
  /** Light core line color (drawn on top of the casing). */
  color: string;
  /** Dark casing/halo color (drawn wider, underneath the core) for contrast. */
  casingColor: string;
  /** Legacy fallback threshold */
  zoomThreshold?: number;
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
