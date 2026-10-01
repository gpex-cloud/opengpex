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
 * BrushOverlay Plugin Protocols
 *
 * Constants + typed facade for the vector BRUSH overlay — the vector
 * spine's `renderer: 'stroke'` tool.
 */

export const PLUGIN_ID = 'overlays.brush_overlay';
export const PLUGIN_AUTHOR = 'opengpex';

// ─── Signal IDs ────────────────────────────────────────────────────────────────

/** Whether a brush stroke is currently being drawn (boolean). */
export const SIGNAL_DRAWING_STROKE = 'signal.drawing_stroke';

// ─── Command IDs ───────────────────────────────────────────────────────────────

/** Places a freshly started stroke as a `type:'vector'` layer (undoable). */
export const CMD_PLACE = 'cmd.place';

// ─── Internal UID Constants ──────────────────────────────────────────────────────

/** Internal command UID: place a new stroke layer. */
export const _CMD_PLACE_UID = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_PLACE}`;

// ─── Tunables ──────────────────────────────────────────────────────────────────

/**
 * Minimum canvas-pixel distance between two RECORDED trajectory samples.
 *
 * Performance guard, not a smoothing filter: `computeCompositeSignature`
 * serializes the whole packed point stream every frame, so an unfiltered
 * pointer feed (which can emit coalesced sub-pixel moves at 240Hz+) makes the
 * signature cost grow without adding a single visible pixel. The final raw
 * sample is always appended on pointerup regardless of this threshold, so the
 * stroke's end point stays exact.
 */
export const MIN_SAMPLE_DISTANCE_PX = 2;

/**
 * Hard cap on trajectory point count for a single continuous (unlifted) drag.
 *
 * Crash-prevention guard, not a UX feature: `StrokeRenderer`'s `vertsRing` is a
 * fixed 8 MiB storage ring (`STROKE_RING_CAPACITY`), holding at most ~43,690
 * segments (~43,691 points) before `BufferRing.allocate` returns an
 * out-of-bounds slot and WebGPU raises a validation error instead of degrading
 * gracefully. `onMove` stops appending new samples once this cap is hit — the
 * stroke drawn so far stays put (it does not disappear), releasing the pointer
 * commits it normally via `tightenStroke`, and the next stroke is unaffected.
 * At `MIN_SAMPLE_DISTANCE_PX`, this is a ≥80,000 logical-px cumulative path
 * budget per drag — normal brush usage will not reach it.
 */
export const MAX_STROKE_POINTS = 40_000;

/**
 * Padding added around the trajectory's raw bounding box when tightening the
 * layer box at commit: half the tip diameter reaches beyond the centre-line,
 * plus 1px for the analytic edge feather.
 */
export const STROKE_BOX_PADDING_EXTRA_PX = 1;

// ─── Cross-Plugin Typed Facade ──────────────────────────────────────────────────

/**
 * BrushOverlayAPI: structured cross-plugin facade for external consumers.
 */
export const BrushOverlayAPI = {
  signals: {
    /** Whether a brush stroke drag is currently in progress. */
    drawingStroke: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_DRAWING_STROKE}` as const,
  },
  /** pluginConfig storage key */
  configKey: `${PLUGIN_AUTHOR}.${PLUGIN_ID}` as const,
} as const;
