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

import { InteractionHandler, InteractionEvent, Layer } from '@opengpex/editor/core/types';
import { TEXT_OVERLAY_CMD_EDIT_START } from '../TextOverlay/protocols';

/**
 * Window between two consecutive pointerdowns that still counts as a
 * double-click (ms). Matches the platform double-click interval closely
 * enough that users cannot tell the difference.
 */
const DBL_CLICK_INTERVAL_MS = 450;

/** Max pointer travel between the two clicks of a double-click (canvas px) */
const DBL_CLICK_TRAVEL_PX = 5;

/**
 * TextDblClickEditHandler: Double Click to Edit under the select tool.
 *
 * In pan (select) mode, double-clicking a text layer activates it and enters
 * the inline editing session via TextOverlay's `cmd.edit_start` — no manual
 * switch to the Text Craft tool required (mirrors Figma/Photoshop behaviour).
 *
 * Detection strategy: `test()` only claims the gesture when THIS pointerdown
 * is the second click of a pair (native detail === 2 when the browser reports
 * it, plus a time/distance fallback for browsers that leave pointerdown
 * detail at 0). Every pointerdown updates the tracker, so the FIRST click of
 * the pair falls through to layer-move untouched — normal click-selection of
 * text layers keeps working exactly as before. When claimed, the handler
 * consumes the whole gesture (no move/end behaviour), so the second click
 * never starts a layer drag.
 *
 * Priority 140: above layer-move (10) so the detected second click wins, and
 * below text-place (150) — that handler is craft-mode-only, so the two never
 * contend for the same gesture.
 */
export const createTextDblClickEditHandler = (): InteractionHandler => {
  // Double-click tracker: last pointerdown time + canvas point. Updated on
  // every pointerdown (test() runs once per gesture start), regardless of
  // whether this handler claims it.
  let lastDownTime = 0;
  let lastDownX = 0;
  let lastDownY = 0;

  const findTextLayerAtPoint = (e: InteractionEvent): Layer | null => {
    const hits = e.geometry.space.pickLayersAt(e.point.world, e.activeFrame.layers);
    return hits.find((l: Layer) => l.type === 'text' && l.visible && !l.locked && !!l.textData) || null;
  };

  return {
    id: 'text-dblclick-edit',
    priority: 140,

    test: (e) => {
      // Select tool only — the text tool owns its own click/double-click
      // semantics via text-place.
      if (e.state.interaction.interactionMode !== 'pan') return false;

      const target = e.nativeEvent.target as HTMLElement | null;
      if (target?.closest('button, a, input, [data-role="ui"], [contenteditable], [data-handle], [data-gizmo-handle], [data-gizmo-rotate]')) return false;

      const now = performance.now();
      const isDoubleClick =
        (e.nativeEvent as MouseEvent).detail === 2 ||
        (now - lastDownTime <= DBL_CLICK_INTERVAL_MS &&
          Math.hypot(e.point.canvas.x - lastDownX, e.point.canvas.y - lastDownY) <= DBL_CLICK_TRAVEL_PX);
      lastDownTime = now;
      lastDownX = e.point.canvas.x;
      lastDownY = e.point.canvas.y;

      if (!isDoubleClick) return false;
      return !!findTextLayerAtPoint(e);
    },

    onStart: (e) => {
      const hitTextLayer = findTextLayerAtPoint(e);
      if (!hitTextLayer) return;
      // cmd.edit_start activates the layer and opens the inline editing
      // session (modify session, own snapshot/undo handling).
      e.actions.executeCommand(TEXT_OVERLAY_CMD_EDIT_START, {
        frameId: e.activeFrame.id,
        layerId: hitTextLayer.id,
      });
    },

    // Claimed gestures are fully consumed: the double-click must never fall
    // through to a layer drag.
    onMove: () => {},
    onEnd: () => {},
  };
};
