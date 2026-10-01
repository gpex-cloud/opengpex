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
 * EraserOverlay Plugin Protocols
 *
 * Constants and signals for the eraser/restore overlay. Eraser edits are
 * non-destructive bitmap masks committed via the core `adv.layer.bitmapMask`
 * actions, so this overlay owns no custom bake command — see index.ts.
 */

export const PLUGIN_ID = 'overlays.eraser_overlay';
export const PLUGIN_AUTHOR = 'opengpex';

// ─── Signal IDs ────────────────────────────────────────────────────────────────

/** Whether a mask stroke is in progress (true = drawing in progress) */
export const SIGNAL_DRAWING_ERASER = 'signal.drawing_eraser';
export const SIGNAL_IS_STROKING = SIGNAL_DRAWING_ERASER;

// ─── Cross-Plugin Constants (cross-plugin references) ───────────────────────────────────────

/** Cross-plugin signal storage key: whether drawing is in progress */
export const ERASER_OVERLAY_SIGNAL_IS_STROKING = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_IS_STROKING}`;

// ─── Default Brush Parameters ──────────────────────────────────────────────────

export const DEFAULT_BRUSH_SIZE = 12;    // px
export const DEFAULT_BRUSH_OPACITY = 100; // %
export const DEFAULT_BRUSH_HARDNESS = 80; // %
export const MIN_BRUSH_SIZE = 1;
export const MAX_BRUSH_SIZE = 500;
