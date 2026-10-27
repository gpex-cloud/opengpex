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

/**
 * Places the in-progress stroke's own layer above the active layer, converting
 * it to the strokes collection schema. Undoable — this IS the gesture's only
 * checkpoint (taken at the first drawable sample; the rest of the trajectory
 * rides the silent volatile track onto the same layer, so undo removes exactly
 * the one stroke layer).
 */
export const CMD_PLACE = 'cmd.place';

// ─── Internal UID Constants ──────────────────────────────────────────────────────

/** Internal command UID: place a stroke layer. */
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

// ─── Input-dynamics tunables ────────────────────────────────────────────────────

/**
 * Reference pointer speed for velocity dynamics, in SCREEN px per millisecond
 * (canvas distances are multiplied by camera zoom before comparison — the
 * hand moves the screen, and the dynamic must feel identical at any zoom).
 * The width factor is the reciprocal of the speed normalized by this value:
 * exactly 1 at reference speed, decaying smoothly and continuously above it
 * down to {@link VELOCITY_MIN_FACTOR}. There is NO threshold step — ~1.2
 * screen px/ms is a normal deliberate hand, so ordinary strokes ride the
 * visible part of the curve instead of sitting in a dead zone below it.
 */
export const VELOCITY_REFERENCE_PXMS = 1.2;

/** Floor for the velocity width factor — fast flicks never vanish entirely. */
export const VELOCITY_MIN_FACTOR = 0.35;

/**
 * Floor for the adaptive EMA factor in the velocity estimator, 0..1. The
 * GIMP-style factor is min(SMOOTHING, normalized speed); without this floor a
 * near-stationary sample would freeze the estimator (factor ~0 = no update),
 * leaving the width stuck at whatever the previous gesture's speed implied.
 */
export const VELOCITY_MIN_NORM = 0.05;

/**
 * Taper zone cap as a multiple of the tip diameter: the slider's 100% maps to
 * this many diameters. One diameter (the pre-20261028 mapping) is same scale
 * as the round end cap it replaces, so the taper was invisible on small tips;
 * five diameters gives a clearly readable calligraphic tip at any size.
 */
export const TAPER_LENGTH_PER_SIZE = 5;

/**
 * Taper zone cap as a fraction of the stroke's total arc length, per end.
 * The arc clamp keeps the diameter multiple from swallowing short strokes:
 * a zone longer than a quarter of the stroke would taper most of the body
 * away and make the slider feel nonlinear.
 */
export const TAPER_ARC_FRACTION = 0.25;

/**
 * EMA factor for the velocity-dynamics signal, 0..1 (higher = less smoothing).
 * Pointer-event timestamps and trackpad/pointer-acceleration speeds are noisy,
 * so the per-sample speed is smoothed twice before it drives width: the time
 * delta is blended with the previous delta, then the resulting speed with the
 * previous speed. Without this the width pulses with input noise on every
 * fast gesture (the 'string of beads' artifact).
 */
export const VELOCITY_SMOOTHING = 0.3;

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
