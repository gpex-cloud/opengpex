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
 * RetouchOverlay Interaction Handler — Pure Orchestration
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
import type { CraftDrawerConfig } from '../../drawers/CraftDrawer/protocols';
import { MOSAIC_OVERLAY_SIGNAL_IS_STROKING } from './protocols';
import { createRetouchSession } from './stroke/factory';
import { executeBake } from './stroke/bake';
import { normalizeMosaicMode } from './stroke/types';
import { pickCloneSource } from './stroke/clone/cloneSource';
import type { StrokeSession } from './stroke/types';

/** Shared signal keys */
const ACTIVE_CRAFT_KEY = CraftDrawerAPI.signals.activeCraft;
const IS_STROKING_KEY = MOSAIC_OVERLAY_SIGNAL_IS_STROKING;

/** Reads the persisted retouch mode from plugin config (whitelist-normalized). */
function currentMode(e: { state: { pluginConfig: Record<string, unknown> } }): string {
  const config = e.state.pluginConfig[CraftDrawerAPI.configKey] as unknown as CraftDrawerConfig | undefined;
  return normalizeMosaicMode(config?.mosaicToolMode);
}

/** Single module-level mutable state: the active stroke session */
let session: StrokeSession | null = null;

/**
 * Tracks in-flight bake operation.
 * When non-null, a previous stroke's async bake (encode → register → state update)
 * is still in progress. New strokes must wait to avoid reading stale React state.
 */
let pendingBake: Promise<void> | null = null;

/**
 * Holds the preview canvas reference during async bake.
 * This ensures StrokePreview continues to render the stroke buffer while the bake
 * is in progress (anti-flash).
 */
let previewHold: OffscreenCanvas | null = null;

// ─── createRetouchStrokeHandler ─────────────────────────────────────────────────

/**
 * MosaicStrokeHandler: Mosaic stroke interaction handler
 *
 * In mosaic craft mode, handles pointerdown -> pointermove -> pointerup
 * complete stroke lifecycle.
 */
export const createRetouchStrokeHandler = (): InteractionHandler => ({
  id: 'mosaic-stroke',
  priority: 150,
  // Alt is a ROUTING spring channel (the Dispatcher filters every handler
  // that does not declare an override on an engaged channel). Clone needs
  // Alt+Click for source picking, so this handler declares the override to
  // stay consultable while Alt is held; the test below yields the press back
  // to layer-move whenever Alt is engaged outside clone mode (the clip
  // creation tools' declare-and-yield precedent). Non-clone modes keep the
  // global temporary-move semantics on Alt.
  springOverride: ['alt'],

  test: (e) => {
    // Only active in craft mode when activeCraft === 'mosaic'
    if (e.state.interaction.interactionMode !== 'craft') return false;
    const craft = e.state.interaction.signals[ACTIVE_CRAFT_KEY];
    if (craft !== 'mosaic') return false;

    // Alt held outside clone mode: yield the press to the global layer-move
    // spring (bare spring fallback, mirroring the clip tools' yield branch).
    if (e.spring.alt && currentMode(e) !== 'clone') return false;

    // Block new strokes while a previous bake is in-flight.
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
    // Clone mode's Alt+Click is the explicit source pick: record the anchor
    // and end the gesture without starting a stroke session.
    if (currentMode(e) === 'clone' && e.keys.alt) {
      pickCloneSource(e.activeFrame.id, e.point.canvas);
      return;
    }

    session = createRetouchSession(e);
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

    // Hold preview canvas during bake for anti-flash
    previewHold = current.previewCanvas;
    session = null;

    const bakePromise = (async () => {
      try {
        const request = await current.end(e.activeFrame);
        if (request) {
          await executeBake(request, e);
        }
      } catch (err) {
        console.error('[RetouchOverlay] Bake failed:', err);
      } finally {
        pendingBake = null;

        // Defer previewHold cleanup by one rAF frame
        const myHold = previewHold;
        requestAnimationFrame(() => {
          if (previewHold === myHold) previewHold = null;
        });
      }
    })();

    pendingBake = bakePromise;
    return bakePromise;
  },
});

// ─── StrokePreview Interface ───────────────────────────────────────────────────

/**
 * Gets currently active stroke buffer (for StrokePreview component reading).
 */
export function getStrokeBuffer(): OffscreenCanvas | null {
  return session?.previewCanvas ?? previewHold ?? null;
}

/**
 * Gets current stroke version for dirty detection.
 */
export function getStrokeVersion(): number {
  return session?.version ?? 0;
}
