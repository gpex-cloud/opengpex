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



/** -----------------------------------------------------------------*/
/** Viewport Settings -----------------------------------------------*/
/** -----------------------------------------------------------------*/

/** Viewport scroll/zoom behavior mode. */
export type ViewportScrollMode = 'legacy' | 'modern';

/**
 * Default viewport scroll mode.
 * - 'legacy': Scroll=Pan, Ctrl/Alt+Scroll=Zoom (Figma/PS style)
 * - 'modern': Scroll=Zoom, Ctrl+Scroll=Pan (Google Maps/Blender style)
 *
 * Currently a static constant; will be promoted to a runtime-switchable
 * preset via PresetsFactory in a future iteration.
 *
 * @see docs/opengpex/plans/20260805_windows_mouse_wheel_fix.md
 */
export const VIEWPORT_SCROLL_MODE: ViewportScrollMode = 'legacy';

// [REFACTOR-2026-06-22] `VIEWPORT_FIT_FACTOR` (0.90) was removed:
// it duplicated the role of `padding` (numeric breathing room) inside
// `getFitCamera`, causing fit-paths to apply both an 80px padding AND
// an extra 10% shrink — wasting space on large screens, cramping small.
// The single source of breathing room is now `padding` passed via
// `CameraCenterOptions`.

/**
 * Default fit-camera padding (in viewport pixels).
 *
 * Geometric breathing room between the canvas and the safe-area boundary
 * during any "fit" computation (`getFitCamera`). This is **orthogonal** to
 * `offsetXxx` (which represents chrome occupancy from LayoutProvider slots).
 *
 * Adjust here to globally tighten/loosen fit results across:
 * - `viewport.fit` / `viewport.actualSize` (translate.ts)
 * - `frame.create.trunk` / `branch` / `revert` (create.ts)
 * - `frame.resize.resizeCanvas` / `resample` (resize.ts)
 * - `useCameraInit` (auto-fit)
 */
export const VIEWPORT_FIT_PADDING = 40;

/** Minimum viewport zoom scale (10% = 0.10). */
export const VIEWPORT_ZOOM_MIN = 0.10;

/** Maximum viewport zoom scale (12800% = 128). */
export const VIEWPORT_ZOOM_MAX = 128;


/**
 * Checkerboard background configuration
 */
export const BACKDROP_GRID_CONFIG = {
  /** Size of a single checkerboard grid cell (unit: pixels) */
  GRID_SIZE: 8,
  /** Whole cycle size of the checkerboard repeating pattern (must equal GRID_SIZE * 2) */
  PATTERN_SIZE: 16,
};


/** -----------------------------------------------------------------*/
/** State Restore / Persistence Settings ----------------------------*/

/**
 * Debounce delay (ms) for committing the camera fast-track to Redux after
 * the user stops any wheel-driven viewport interaction (pan, zoom, or both).
 *
 * Lower values reduce the time window in which a page refresh can lose the
 * user's latest camera position. The commit itself is cheap
 * (one Redux dispatch) and does not affect rendering performance,
 * which runs entirely on the fast-track at 60fps.
 *
 * Total persistence latency = VIEWPORT_CAMERA_COMMIT_DEBOUNCE_MS + auto-save debounce (200ms).
 */
export const VIEWPORT_CAMERA_COMMIT_DEBOUNCE_MS = 200;

/**
 * Maximum time (ms) to wait for IndexedDB state restore on page load.
 * If exceeded, the editor loads an empty workspace and shows Recovery Mode.
 * Uses a generous timeout because IndexedDB can be slow after CPU-intensive
 * operations (AI inference, large model downloads filling Cache Storage).
 */
export const RESTORE_TIMEOUT_MS = 8000;


/** -----------------------------------------------------------------*/
/** Clip / Selection Tool Settings ----------------------------------*/
/** -----------------------------------------------------------------*/

/**
 * Whether switching between regular clip tools (rect ↔ ellipse) inherits
 * the bounding box from the previous tool.
 *
 * - `true`  (default): rect→ellipse copies the rect's bounds into the
 *   ellipse slot (same area, different shape). Good for "crop mode" UX
 *   where the user adjusts a persistent region and wants to preview
 *   different shapes without redrawing.
 *
 * - `false`: each tool maintains its own independent slot. Switching
 *   tools starts from an empty selection (Photoshop-style marquee
 *   behavior). The user must draw a fresh selection after switching.
 *
 * Future: wire this into Preferences UI so users can choose their
 * preferred workflow.
 */
export const CLIP_REGULAR_TOOL_SWITCH_INHERITS_BOUNDS = true;


/** -----------------------------------------------------------------*/
/** Snap / Smart Guides Settings ------------------------------------*/
/** -----------------------------------------------------------------*/

/** Snap to canvas edges and center lines */
export const SNAP_TO_CANVAS: boolean = true;
/** Snap to layer's birth position (initial spawn center) */
export const SNAP_TO_BIRTH: boolean = true;
/** Snap to other layers */
export const SNAP_TO_LAYERS: boolean = true;
/** Layer types excluded from snapping source */
export const SNAP_EXCLUDE_LAYER_TYPES: string[] = [];
/** Ignore locked layers as snap targets */
export const SNAP_IGNORE_LOCKED_LAYERS: boolean = true;
/** Ignore layers with screen projection area below threshold */
export const SNAP_IGNORE_SMALL_LAYERS: boolean = true;
/** Small layer threshold in screen pixels² (default 400 ≈ 20×20) */
export const SNAP_SMALL_LAYER_THRESHOLD: number = 400;
/** Maximum number of layers participating in snap calculation */
export const SNAP_MAX_TARGETS: number = 50;
/** Edge snap scope during resize: 'recanvas' | 'all' */
export const SNAP_EDGE_SCOPE: 'recanvas' | 'all' = 'recanvas';

