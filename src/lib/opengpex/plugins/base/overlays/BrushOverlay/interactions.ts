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
 * BrushOverlay Interaction Handler — Pure Orchestration
 *
 * Delegates stroke lifecycle to StrokeSession abstraction:
 * - onStart: create session via factory, begin stroke
 * - onMove: forward point to session
 * - onEnd: finalize session, execute bake pipeline
 *
 * All drawing logic, buffer management, and bake computation
 * are encapsulated in the stroke/ module.
 */

import type { InteractionHandler } from '@opengpex/editor/core/types';
import { CraftDrawerAPI } from '../../drawers/CraftDrawer/protocols';
import { BRUSH_OVERLAY_SIGNAL_IS_STROKING } from './protocols';
import { createStrokeSession } from './stroke/factory';
import { executeBake } from './stroke/bake';
import type { StrokeSession } from './stroke/types';

/** Shared signal keys */
const ACTIVE_CRAFT_KEY = CraftDrawerAPI.signals.activeCraft;
const IS_STROKING_KEY = BRUSH_OVERLAY_SIGNAL_IS_STROKING;

/** Single module-level mutable state: the active stroke session */
let session: StrokeSession | null = null;

/**
 * Tracks in-flight bake operation.
 * When non-null, a previous stroke's async bake (encode → register → state update)
 * is still in progress. New strokes must wait to avoid reading stale React state
 * (e.g. layer.bitmapMasks not yet reflecting the previous bake's mask addition).
 */
let pendingBake: Promise<void> | null = null;

/**
 * Holds the preview canvas reference during async bake.
 * This ensures StrokePreview continues to render the stroke buffer while the bake
 * is in progress (anti-flash: paint/mosaic sessions need this because they rely on
 * getStrokeBuffer() for live preview, unlike mask sessions which use fast.override).
 */
let previewHold: OffscreenCanvas | null = null;

// ─── createBrushStrokeHandler ──────────────────────────────────────────────────

/**
 * BrushStrokeHandler: Brush stroke interaction handler
 *
 * In brush/eraser/restore craft mode, handles pointerdown -> pointermove -> pointerup
 * complete stroke lifecycle.
 */
export const createBrushStrokeHandler = (): InteractionHandler => ({
  id: 'brush-stroke',
  priority: 150,

  test: (e) => {
    // Only active in craft mode when activeCraft === 'brush' or 'eraser' or 'restore'
    if (e.state.interaction.interactionMode !== 'craft') return false;
    const craft = e.state.interaction.signals[ACTIVE_CRAFT_KEY];
    if (craft !== 'brush' && craft !== 'eraser' && craft !== 'restore' && craft !== 'mosaic') return false;

    // Block new strokes while a previous bake is in-flight.
    // This prevents the race condition where a new mask stroke reads stale
    // React state (bitmapMasks=[]) before the previous bake has committed.
    if (pendingBake) return false;

    const mouseEvent = e.nativeEvent as MouseEvent;

    // Exclude UI element click
    const target = mouseEvent.target as HTMLElement;
    if (target.closest('button, a, input, [data-role="ui"], [contenteditable]')) return false;

    // Click within canvas range
    const frame = e.activeFrame;
    return e.geometry.space.isPointInRect(e.point.canvas, {
      x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h,
    });
  },

  onStart: (e) => {
    session = createStrokeSession(e);
    if (!session) return;

    session.begin(e.point.canvas, e.pointer.pressure || 0.5);
    e.actions.setStateSignal(IS_STROKING_KEY, true);
  },

  onMove: (e) => {
    if (!session) return;
    session.move(e.point.canvas, e.pointer.pressure || 0.5, e);
  },

  onEnd: (e) => {
    if (!session) return;

    e.actions.setStateSignal(IS_STROKING_KEY, false);
    const current = session;

    // Hold preview canvas during bake for anti-flash (paint/mosaic sessions).
    // Mask sessions use fast.override for preview so this is a no-op 1x1 canvas.
    previewHold = current.previewCanvas;
    session = null;

    const bakePromise = (async () => {
      try {
        const request = await current.end(e.activeFrame);
        if (request) {
          await executeBake(request, e);
        }
      } catch (err) {
        console.error('[BrushOverlay] Bake failed:', err);
      } finally {
        // Clear the pending lock and preview hold so the next stroke can proceed.
        pendingBake = null;
        previewHold = null;
      }
    })();

    pendingBake = bakePromise;
    return bakePromise;
  },
});

// ─── StrokePreview Interface ───────────────────────────────────────────────────

/**
 * Gets currently active stroke buffer (for StrokePreview component reading).
 *
 * Returns the session's preview canvas during active stroke, or the held preview
 * canvas during async bake (anti-flash), or null if idle.
 */
export function getStrokeBuffer(): OffscreenCanvas | null {
  return session?.previewCanvas ?? previewHold ?? null;
}

/**
 * Gets current stroke version for dirty detection.
 *
 * Increments on each onMove draw. StrokePreview's Ticker compares version numbers
 * to determine if preview canvas needs redraw.
 */
export function getStrokeVersion(): number {
  return session?.version ?? 0;
}
