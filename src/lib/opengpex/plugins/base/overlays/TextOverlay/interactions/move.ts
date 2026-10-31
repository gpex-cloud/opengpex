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

import { InteractionHandler } from '@opengpex/editor/core/types';
import { InteractionTransaction } from '@opengpex/editor/stage/interaction/Transaction';
import {
  ACTIVE_CRAFT_KEY,
  CMD_EDIT_START_UID,
  EDITING_TEXT_KEY,
  findEditableTextLayerAtPoint,
  setPendingEditCaretPoint,
} from './shared';

// ─── TextMoveHandler ───────────────────────────────────────────────────────────

/**
 * Drag-gesture flag shared with the hover-cursor effect (hooks.ts): while a
 * move drag is live the gesture owns the cursor ('grabbing') and the hover
 * rule must not fight it. Set in onStart, cleared in onEnd — the trailing
 * state update from tx.commit re-renders the overlay AFTER the clear, so the
 * hover rule re-applies the correct cursor without any mousemove.
 */
let textMoveDragActive = false;
export function isTextMoveDragging(): boolean {
  return textMoveDragActive;
}

/**
 * TextMoveHandler: press routing for existing text layers
 *
 * Three distinct gestures, one handler:
 * - EDITING state: Cmd/Ctrl + drag moves the layer while the session stays
 *   alive. Without a modifier every press in the box stays with the
 *   contenteditable (caret placement / text selection) — plain press-drag
 *   inside the editor is NOT a move.
 * - PRE-EDIT state, spring key: Cmd/Ctrl + drag over a text layer moves it;
 *   the press also flips the active layer (drag selects + moves in one
 *   gesture).
 * - PRE-EDIT state, bare press: ENTERS EDITING (Photoshop model — the text
 *   tool's click on existing text is an edit, not a move; move requires the
 *   spring key). The gesture is claimed and fully consumed: the inline
 *   editing session opens with the caret at the clicked position, and the
 *   place handler never sees presses on text layers (no accidental stacked
 *   boxes). After the gesture ends the editor owns subsequent presses.
 */
export const createTextMoveHandler = (): InteractionHandler => {
  let startCanvas = { x: 0, y: 0 };
  let startLayerPos = { x: 0, y: 0 };
  let targetLayerId: string | null = null;
  let selectOnStart = false;
  // Bare pre-edit press: the claimed gesture OPENS the editing session
  // instead of moving (see the doc comment above).
  let editOnStart = false;
  let tx: InteractionTransaction | null = null;

  return {
    id: 'text-move',
    priority: 170, // Highest priority (intercept first when Cmd is pressed)
    // Editing-state Cmd+drag = move this text layer (protects the contenteditable).
    springOverride: 'meta',

    test: (e) => {
      // Must be in craft mode and activeCraft === 'text'
      if (e.state.interaction.interactionMode !== 'craft') return false;
      if (e.state.interaction.signals[ACTIVE_CRAFT_KEY] !== 'text') return false;

      // Exclude UI elements
      const mouseEvent = e.nativeEvent as MouseEvent;
      const target = mouseEvent.target as HTMLElement;
      if (target.closest('button, a, input, [data-role="ui"]')) return false;
      // Resize/rotate handles own their gestures (this handler's priority 170
      // would otherwise swallow them), so a pointerdown on one must never
      // become a move.
      if (target.closest('[data-gizmo-handle], [data-gizmo-rotate]')) return false;

      // Case 1: Layer being edited -> use as target directly.
      // Editing state: ONLY Cmd/Ctrl + drag moves the layer. Every plain
      // press in the box — border band included — stays with the
      // contenteditable (caret placement / text selection).
      const editingId = e.state.interaction.signals[EDITING_TEXT_KEY] as string | null;
      if (editingId) {
        targetLayerId = editingId;
        selectOnStart = false;
        editOnStart = false;
        return mouseEvent.metaKey || mouseEvent.ctrlKey;
      }

      // Case 2: Pre-editing state — a press over an existing EDITABLE text
      // layer (topmost wins) is claimed; what it means depends on the spring
      // key: engaged → drag moves the layer (select-on-start); bare → open
      // the editing session with the caret at the click position. Either way
      // the place handler never sees the press (no stacked boxes). A bare
      // press OFF any text layer falls through to TextPlaceHandler (create).
      const hitLayer = findEditableTextLayerAtPoint(e);
      if (hitLayer) {
        targetLayerId = hitLayer.id;
        selectOnStart = e.spring.meta;
        editOnStart = !e.spring.meta;
        return true;
      }
      return false;
    },

    onStart: (e) => {
      if (!targetLayerId) return;
      const frame = e.activeFrame;
      const layer = frame.layers.byId[targetLayerId];
      if (!layer) return;

      // Bare pre-edit press: open the inline editing session with the caret
      // at the clicked position (same entry the pan-mode double-click uses)
      // and consume the whole gesture — nothing may drag while the editor
      // boots.
      if (editOnStart) {
        const mouseEvent = e.nativeEvent as MouseEvent;
        setPendingEditCaretPoint({ clientX: mouseEvent.clientX, clientY: mouseEvent.clientY });
        e.actions.executeCommand(CMD_EDIT_START_UID, {
          frameId: frame.id,
          layerId: targetLayerId,
        });
        return;
      }

      if (selectOnStart) {
        e.actions.setActiveLayer(frame.id, targetLayerId);
        // The gesture owns the cursor while it lives (hover rule yields).
        textMoveDragActive = true;
      }

      startCanvas = { x: e.point.canvas.x, y: e.point.canvas.y };
      startLayerPos = { x: layer.cx, y: layer.cy };

      // Non-silent: the gesture creates its own undo checkpoint (independent
      // immediate transaction — the editing session's commit no longer carries
      // geometry, so the move must be undoable on its own).
      tx = new InteractionTransaction(e);
      tx.begin();

      // Set grabbing onStart (fast-track, no React re-render)
      e.actions.fast.cursor.notifyDragging('grabbing');
    },

    onMove: (e) => {
      if (!targetLayerId || !tx) return;

      const dx = e.point.canvas.x - startCanvas.x;
      const dy = e.point.canvas.y - startCanvas.y;

      tx.update({ cx: startLayerPos.x + dx, cy: startLayerPos.y + dy }, 'layer', targetLayerId);
    },

    onEnd: (e) => {
      // Tear down gesture state before anything else: the hover-cursor rule
      // must see the flags cleared no matter what commit does.
      const wasPreEditDrag = selectOnStart;
      const wasEditingDrag = !selectOnStart && !!tx;
      targetLayerId = null;
      selectOnStart = false;
      editOnStart = false;
      textMoveDragActive = false;

      if (tx) {
        tx.commit();
        tx = null;
      }

      if (wasPreEditDrag || wasEditingDrag) {
        // Release the gesture cursor; the service falls back to the spring
        // key state (a still-held Cmd keeps showing the move cursor).
        e.actions.fast.cursor.notifyDragging(null);
      }
    },

    onCancel: (e) => {
      // Same teardown as onEnd's pre-edit path; the hover rule reapplies on
      // the next mousemove or re-render.
      if (tx) {
        tx = null;
      }
      targetLayerId = null;
      selectOnStart = false;
      editOnStart = false;
      textMoveDragActive = false;
      e.actions.fast.cursor.notifyDragging(null);
    },
  };
};
