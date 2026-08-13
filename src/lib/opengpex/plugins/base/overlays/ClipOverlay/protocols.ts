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

export const PLUGIN_ID = 'overlays.clip_overlay';
export const PLUGIN_AUTHOR = 'opengpex';

// ─── Plugin Config API ───────────────────────────────────────────────────────

export interface ClipOverlayConfig {
  maskOpacity: number;
  marchingAntsAnimated: boolean;
}

/**
 * ClipOverlayAPI: Public facade for cross-plugin access.
 *
 * Usage:
 *   const config = state.pluginConfig[ClipOverlayAPI.configKey] as ClipOverlayConfig;
 */
export const ClipOverlayAPI = {
  /** pluginConfig storage key */
  configKey: `${PLUGIN_AUTHOR}.${PLUGIN_ID}` as const,
} as const;

// ─── Marching Ants Performance Tuning ────────────────────────────────────────

/** CSS animation duration (seconds) for marching ants stroke-dashoffset. */
export const MARCHING_ANTS_DURATION_S = 1;

/**
 * Whether to animate the marching ants (stroke-dashoffset cycling).
 *
 * When `true`: Classic animated marching ants (Photoshop/GIMP style).
 *   - Visually appealing, clear selection boundary indication
 *   - GPU cost: triggers per-frame compositor work; when selection overlaps with
 *     `backdrop-filter` UI panels, can cause 50-90%+ GPU usage
 *
 * When `false`: Static dashed line (Photopea style).
 *   - Zero ongoing GPU cost (no CSS animation = compositor can idle)
 *   - Selection is still clearly visible via dual-path high-contrast technique
 *   - Recommended for devices with limited GPU or when backdrop-filter is used
 *
 * This can be toggled at runtime via user preferences in a future iteration.
 */
export const MARCHING_ANTS_ANIMATED = false;

/**
 * Max total vertices for the marching ants SVG path.
 * Polygons exceeding this are Douglas–Peucker simplified to this budget.
 * Lower = less GPU rasterization cost per frame (fewer path segments to stroke).
 *
 * GPU impact: More vertices = more work for the SVG rasterizer each frame.
 * With animation enabled, this cost is multiplied by the frame rate (60-120fps).
 * With animation disabled (static), vertices only affect initial paint cost.
 *
 * Visual impact: More vertices = smoother/more accurate selection outline.
 * 400 is a good balance; complex selections (wand/lasso) may benefit from
 * higher values (800-1200) for accuracy, at the cost of GPU during animation.
 *
 * Recommended ranges:
 *   - 200-400: Fast, suitable for simple rect/ellipse selections
 *   - 400-800: Balanced, good for most use cases
 *   - 800-1500: High fidelity, for complex polygon/wand selections
 */
export const MARCHING_ANTS_MAX_VERTICES = 600;
