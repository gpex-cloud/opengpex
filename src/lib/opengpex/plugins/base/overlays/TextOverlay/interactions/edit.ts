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

import { InteractionHandler, Layer } from '@opengpex/editor/core/types';
import { CraftDrawerAPI } from '../../../drawers/CraftDrawer/protocols';
import {
  CMD_EDIT_START_UID,
  EDITING_TEXT_KEY,
  findEditableTextLayerAtPoint,
  setPendingEditCaretPoint,
} from './shared';

// ─── TextDblClickEditHandler ───────────────────────────────────────────────────

/**
 * Window between two consecutive pointerdowns that still counts as a
 * double-click (ms). Matches the platform double-click interval closely
 * enough that users cannot tell the difference.
 */
const DBL_CLICK_INTERVAL_MS = 450;

/** Max pointer travel between the two clicks of a double-click (canvas px) */
const DBL_CLICK_TRAVEL_PX = 5;

/**
 * TextDblClickEditHandler: double-click a text layer in PAN mode to edit it.
 *
 * Double-clicking a text layer from the pan tool activates the Text Craft
 * tool and enters the inline editing session via `cmd.edit_start` (mirrors
 * Figma/Photoshop behaviour). When the editing session ends the user lands in
 * the text tool's pre-edit state — a further Esc or V is needed to return to
 * pan. Registered by the TextOverlay plugin though it fires in pan mode: the
 * dispatcher arbitrates all plugins' handlers in one global priority pool, so
 * living here (its behaviour owner) costs nothing and keeps LayerOverlay free
 * of any text knowledge.
 *
 * Inside the text tool's pre-edit state there is no double-click path any
 * more: a BARE single press on a text layer enters editing directly
 * (TextMoveHandler, Photoshop model), and the second press of what used to be
 * a double-click lands inside the live contenteditable as the browser's
 * native word-select.
 *
 * Detection strategy: `test()` only claims the gesture when THIS pointerdown
 * is the second click of a pair (native detail === 2 when the browser reports
 * it, plus a time/distance fallback for browsers that leave pointerdown
 * detail at 0). Every pointerdown updates the tracker, so the FIRST click of
 * the pair falls through to layer-move untouched. When claimed, the handler
 * consumes the whole gesture (no move/end behaviour), so the second click
 * never starts a layer drag.
 */
export const createTextDblClickEditHandler = (): InteractionHandler => {
  // Double-click tracker: last pointerdown time + canvas point. Updated on
  // every pointerdown (test() runs once per gesture start), regardless of
  // whether this handler claims it.
  let lastDownTime = 0;
  let lastDownX = 0;
  let lastDownY = 0;

  return {
    id: 'text-dblclick-edit',
    priority: 175,

    test: (e) => {
      // Pan mode only — inside the text tool a bare single press already
      // enters editing (TextMoveHandler). Never during a live editing
      // session — double-click inside the editor is the browser's word-select.
      if (e.state.interaction.signals[EDITING_TEXT_KEY]) return false;
      if (e.state.interaction.interactionMode !== 'pan') return false;

      const target = e.nativeEvent.target as HTMLElement | null;
      if (target?.closest('button, a, input, [data-role="ui"], [contenteditable], [data-handle], [data-text-gizmo] [data-gizmo-handle], [data-text-gizmo] [data-gizmo-rotate]')) return false;

      const now = performance.now();
      const isDoubleClick =
        (e.nativeEvent as MouseEvent).detail === 2 ||
        (now - lastDownTime <= DBL_CLICK_INTERVAL_MS &&
          Math.hypot(e.point.canvas.x - lastDownX, e.point.canvas.y - lastDownY) <= DBL_CLICK_TRAVEL_PX);
      lastDownTime = now;
      lastDownX = e.point.canvas.x;
      lastDownY = e.point.canvas.y;

      if (!isDoubleClick) return false;
      return !!findEditableTextLayerAtPoint(e);
    },

    onStart: (e) => {
      const hitTextLayer: Layer | null = findEditableTextLayerAtPoint(e);
      if (!hitTextLayer) return;
      // Hand the double-click point to the inline editor so the caret lands
      // where the user double-clicked instead of at the end of the text.
      const mouseEvent = e.nativeEvent as MouseEvent;
      setPendingEditCaretPoint({ clientX: mouseEvent.clientX, clientY: mouseEvent.clientY });
      // Activate the text tool FIRST so the editing session runs inside the
      // text craft state machine: when the session ends the user lands in
      // the tool's pre-edit state (drawer open, place/move semantics live).
      // Pan mode guarantees the craft is not active (activateCraft is a
      // toggle — activating it unconditionally here is safe).
      e.actions.executeCommand(CraftDrawerAPI.commands.activateText.uid);
      // cmd.edit_start activates the layer and opens the inline editing
      // session (modify session, own snapshot/undo handling).
      e.actions.executeCommand(CMD_EDIT_START_UID, {
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
