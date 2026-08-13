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

/** Minimum viewport zoom scale (1% = 0.01). */
export const VIEWPORT_ZOOM_MIN = 0.01;

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
/** Interaction Settings --------------------------------------------*/
/** -----------------------------------------------------------------*/

/**
 * Static click threshold (canvas-space pixels).
 *
 * Below this distance, a pointer-down→up sequence is treated as a "click"
 * rather than a "drag". Affects all TransformHandler-based interactions
 * (layer move/resize, selection move, Re-Canvas resize, etc.).
 *
 * Industry reference:
 *   - Photoshop: ~0px (any movement = drag)
 *   - Figma: ~2px
 *   - Chrome drag API: 4px (Windows) / 10px (macOS)
 *
 * Note: Selection CREATION is not affected by this threshold because the
 * creation handler's `onUpdate` fires on every pointermove (producing a
 * live-updating rect). The threshold only determines whether the result is
 * COMMITTED (drag) or DISCARDED (click) at pointer-up. For create-type
 * handlers, even a 1px drag produces a committed selection because their
 * gesture rules don't discard on static — they only use `isStatic` for
 * "click to deselect" behavior on EXISTING selections.
 */
export const STATIC_CLICK_THRESHOLD: number = 2;

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

