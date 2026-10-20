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

import { InteractionHandler, InteractionEvent, GeometryService, Layer, Frame, LocalRect, asLocalShape, asWorldRect } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { InteractionTransaction } from '@opengpex/editor/stage/interaction/Transaction';
import { createTransformHandler, ResizeHandle } from '@opengpex/editor/stage/interaction/handlers/TransformHandler';
import { ROTATE_CURSOR, TEXT_PREEDIT_CURSOR } from '@opengpex/editor/icons';
import { TEXT_LAYER_PADDING } from '@opengpex/editor/core/helpers/config';
import { CraftDrawerAPI, getReferenceFontSize, TEXT_DEFAULT_LINE_HEIGHT } from '../../drawers/CraftDrawer/protocols';
import { getInitialLineBoxHeight, getInitialPointTextBoxWidth } from './geometry';
import type { PendingTextData } from '../../drawers/CraftDrawer/protocols';
import { TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, _CMD_PLACE_UID, _CMD_EDIT_START_UID } from './protocols';
import { TEXT_OVERLAY_EVT_COMMIT_REQUEST, TEXT_PLACE_MARQUEE_TRANSIENT_KEY } from './protocols';
import type { PlaceMarqueeRect } from './protocols';
import { ColorOptionsAPI } from '../../options/ColorOptions/protocols';
import { fromHex, type ColorValue } from '@opengpex/editor/core/engine/color';
// ─── Edit-start caret handoff ──────────────────────────────────────────────────

/**
 * One-shot handoff of the pointer position that started a text edit session.
 *
 * The interaction handlers below (text-place click, pan-mode double-click)
 * know WHERE the user clicked, but the inline editor mounts later (React
 * effect). The starter stores the viewport-space point here; the editor's
 * init effect consumes it once to drop the caret at the clicked position (via
 * TextCaretKit's placeCaretAtPoint) instead of always collapsing to the text
 * end. Consume-on-read: the value is only valid for the very next session
 * mount; non-pointer entry paths never store one and get the fallback.
 */
export interface PendingEditCaretPoint {
  clientX: number;
  clientY: number;
}

let pendingEditCaretPoint: PendingEditCaretPoint | null = null;

export function setPendingEditCaretPoint(point: PendingEditCaretPoint): void {
  pendingEditCaretPoint = point;
}

export function consumePendingEditCaretPoint(): PendingEditCaretPoint | null {
  const point = pendingEditCaretPoint;
  pendingEditCaretPoint = null;
  return point;
}

/** Shared signal keys (cross-plugin constants) */
const ACTIVE_CRAFT_KEY = CraftDrawerAPI.signals.activeCraft;
const EDITING_TEXT_KEY = TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID;

/** Command UIDs (from protocols, Single Source of Truth) */
const CMD_PLACE_UID = _CMD_PLACE_UID;
const CMD_EDIT_START_UID = _CMD_EDIT_START_UID;

/**
 * Finds hit layer of type 'text' using core geometry hit-testing.
 * Uses pickLayersAt (supports visibleShape, rotation, interactive flag) filtered to text layers.
 * Accepts canvas-local point and converts to world coordinates via geometry service.
 * Exported for the hover-cursor effect in hooks.ts, which has no
 * InteractionEvent and replicates this hit test on raw mousemove.
 */
export function findTextLayerAtPoint(geometry: GeometryService, frame: Frame, point: { x: number; y: number }): Layer | null {
  const worldPoint = geometry.space.localToWorld(point.x, point.y, frame);
  const hits = geometry.space.pickLayersAt(worldPoint, frame.layers);
  return hits.find((l: Layer) => l.type === 'text') || null;
}

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
 * TextMoveHandler: drag to move text layer
 *
 * Two distinct gestures, one handler:
 * - EDITING state: Cmd/Ctrl + drag moves the layer while the session stays
 *   alive. Without a modifier every press in the box stays with the
 *   contenteditable (caret placement / text selection) — plain press-drag
 *   inside the editor is NOT a move.
 * - PRE-EDIT state (two-level click model): a plain drag anywhere over a text
 *   layer moves it, no modifier needed. A press also flips the active layer
 *   (drag-on-unselected selects + moves in one gesture). The gesture is
 *   claimed even for a press that never drags: the active-layer flip IS the
 *   click-to-select of the two-level model (place handler never sees presses
 *   on text layers).
 *
 * Design considerations:
 * - Does not trigger entering/exiting editing state
 * - Cursor position remains after moving in editing state (only changes cx/cy)
 * - Independent undoable transaction: tx.begin() creates its own history step
 *   that lands immediately at drag end (NOT silent) — a deliberate geometry
 *   move is an undoable edit in its own right, ordered before the session's
 *   CMD_MODIFY_COMMIT when both happen during one editing session.
 * - The second press of a double-click is yielded (detail===2, plus a
 *   time/distance fallback) so text-dblclick-edit can claim it — a move drag
 *   must never steal the double-click-to-edit gesture.
 */
export const createTextMoveHandler = (): InteractionHandler => {
  let startCanvas = { x: 0, y: 0 };
  let startLayerPos = { x: 0, y: 0 };
  let targetLayerId: string | null = null;
  let selectOnStart = false;
  let tx: InteractionTransaction | null = null;

  // Double-click yield tracker (see the doc comment above).
  let lastDownTime = 0;
  let lastDownX = 0;
  let lastDownY = 0;

  return {
    id: 'text-move',
    priority: 170, // Highest priority (intercept first when Cmd is pressed)

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

      // Yield the second press of a double-click pair to text-dblclick-edit
      // (native detail, plus a time/distance fallback for browsers that leave
      // pointerdown detail at 0).
      const now = performance.now();
      const isSecondClick =
        mouseEvent.detail === 2 ||
        (now - lastDownTime <= DBL_CLICK_INTERVAL_MS &&
          Math.hypot(e.point.canvas.x - lastDownX, e.point.canvas.y - lastDownY) <= DBL_CLICK_TRAVEL_PX);
      lastDownTime = now;
      lastDownX = e.point.canvas.x;
      lastDownY = e.point.canvas.y;
      if (isSecondClick) return false;

      // Case 1: Layer being edited -> use as target directly.
      // Editing state: ONLY Cmd/Ctrl + drag moves the layer. Every plain
      // press in the box — border band included — stays with the
      // contenteditable (caret placement / text selection).
      const editingId = e.state.interaction.signals[EDITING_TEXT_KEY] as string | null;
      if (editingId) {
        targetLayerId = editingId;
        selectOnStart = false;
        return mouseEvent.metaKey || mouseEvent.ctrlKey;
      }

      // Case 2: Pre-editing state — a plain press anywhere over a text layer
      // (topmost wins) claims the gesture: the drag moves the layer and the
      // press itself selects it (active-layer flip in onStart). No modifier.
      const hitLayer = findTextLayerAtPoint(e.geometry, e.activeFrame, e.point.canvas);
      if (hitLayer) {
        targetLayerId = hitLayer.id;
        selectOnStart = true;
        return true;
      }
      return false;
    },

    onStart: (e) => {
      if (!targetLayerId) return;
      const frame = e.activeFrame;
      const layer = frame.layers.byId[targetLayerId];
      if (!layer) return;

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
      e.actions.fast.setCursor('grabbing');
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
      textMoveDragActive = false;

      if (tx) {
        tx.commit();
        tx = null;
      }

      if (wasPreEditDrag) {
        // Reapply the hover rule for the current pointer position — the same
        // source of truth as the reactive rule in hooks.ts. The write here is
        // required because nothing else may change cursorOverride after the
        // gesture, and the rule's own 'grabbing' guard would otherwise latch.
        const overBox = !!findTextLayerAtPoint(e.geometry, e.activeFrame, e.point.canvas);
        e.actions.fast.setCursor(overBox ? 'grab' : TEXT_PREEDIT_CURSOR);
      } else if (wasEditingDrag) {
        // Editing-state Cmd-drag: restore per the (possibly still held) modifier.
        const stillHoldingModifier =
          e.keys.meta || (e.nativeEvent as MouseEvent).ctrlKey;
        e.actions.fast.setCursor(stillHoldingModifier ? 'grab' : null);
      }
    },

    onCancel: () => {
      // Same teardown as onEnd's pre-edit path; the cursor is left for the
      // hover rule, which reapplies on the next mousemove or re-render.
      if (tx) {
        tx = null;
      }
      targetLayerId = null;
      selectOnStart = false;
      textMoveDragActive = false;
    },
  };
};

// ─── TextResizeHandler ─────────────────────────────────────────────────────────

/**
 * Resolves the text layer a transform-gizmo handle belongs to. The pre-edit
 * frame (corners / edge ticks / rotate handle) is drawn by TextOverlay itself
 * (components/PreEditFrame) and its box carries
 * `data-overlay-gizmo-layer=<layerId>`, so the hit DOM node identifies the
 * target unambiguously (the editing-state gizmo was removed with the
 * session-gizmo split — geometry changes happen either pre-edit here or via
 * Cmd+Drag move).
 */
function resolveGizmoTargetLayer(e: InteractionEvent): Layer | null {
  const target = e.nativeEvent.target as HTMLElement | null;
  if (!target) return null;
  const host = target.closest('[data-overlay-gizmo-layer]');
  const layerId = host?.getAttribute('data-overlay-gizmo-layer');
  if (!layerId) return null;
  const layer = e.activeFrame.layers.byId[layerId];
  return layer && layer.type === 'text' ? layer : null;
}

/**
 * TextResizeHandler: pre-edit text box scaling interaction handler
 *
 * Active in text craft pre-edit state, identifying drag direction via
 * data-gizmo-handle attribute (the handles are the corner brackets / edge
 * ticks of TextOverlay's own PreEditFrame), using createTransformHandler
 * factory to implement
 * standard 8-direction scaling. Automatically switches to fixed boxMode after
 * dragging. Non-silent: the resize lands as its own undoable history step.
 */
export const createTextResizeHandler = (): InteractionHandler => {
  // Orientation-aware resize snapshot (non-null only for rotated/mirrored text):
  // the world centre and the local-axes rect at gesture start, used to map the
  // local resize result back to world cx/cy. Mirrors MarkerOverlay's handler.
  let startCenter: { cx: number; cy: number } | null = null;
  let startLocalRect: { x: number; y: number; w: number; h: number } | null = null;
  let targetLayerId: string | null = null;

  return createTransformHandler({
    id: 'text-resize',
    priority: 160,

    test: (e) => {
      // Must be in text craft mode (the gizmo is force-shown only there)
      if (e.state.interaction.interactionMode !== 'craft') return null;
      if (e.state.interaction.signals[ACTIVE_CRAFT_KEY] !== 'text') return null;

      // Only responds to resize handle clicks
      const target = e.nativeEvent.target as HTMLElement;
      if (!target.closest('[data-gizmo-handle]')) return null;

      const handleEl = target.closest('[data-gizmo-handle]') as HTMLElement;
      const handleType = handleEl.dataset.gizmoHandle;
      // Exclude 'move' (clicks inside the box fall through to other handlers)
      if (!handleType || handleType === 'move') return null;

      const layer = resolveGizmoTargetLayer(e);
      if (!layer) return null;
      targetLayerId = layer.id;

      return { category: 'resize', handle: handleType as ResizeHandle };
    },

    getInitialState: (e) => {
      const frame = e.activeFrame;
      const layer = targetLayerId ? frame.layers.byId[targetLayerId] : null;
      if (!layer) return { x: 0, y: 0, w: 0, h: 0 } as LocalRect;
      const canvas = frame.canvas;

      // Rotated / mirrored text → work in the layer's LOCAL axes. Origin is the
      // bounding-box top-left, so the rect is simply (0,0,w,h); the framework
      // maps pointer deltas into this space via getOrientation.
      if (e.geometry.transform.isRotatedPose(layer)) {
        startCenter = { cx: layer.cx, cy: layer.cy };
        startLocalRect = { x: 0, y: 0, w: layer.bounding.w, h: layer.bounding.h };
        return startLocalRect as LocalRect;
      }

      // Axis-aligned text → canvas-local rect.
      startCenter = null;
      startLocalRect = null;
      return {
        x: canvas.w / 2 + layer.cx - layer.bounding.w / 2,
        y: canvas.h / 2 + layer.cy - layer.bounding.h / 2,
        w: layer.bounding.w,
        h: layer.bounding.h,
      } as LocalRect;
    },

    // Opt into orientation-aware resize: after a canvas Rotate Left/Right the
    // text layer carries a non-zero `rotation` while its `bounding` is
    // unchanged, so the resize math must run in the layer's own axes. Returns
    // null when unrotated so the framework short-circuits to the canvas path.
    // cx/cy are supplied so the framework can project the local rect back into
    // canvas space for rotation-aware edge snapping (snapEdgeRotated).
    getOrientation: (e) => {
      const layer = targetLayerId ? e.activeFrame.layers.byId[targetLayerId] : null;
      if (!layer) return null;
      return { rotation: layer.rotation, flip: layer.flip, cx: layer.cx, cy: layer.cy };
    },

    getConstraints: () => ({
      aspect: undefined,
      clamp: false,
    }),

    onUpdate: (e, newRect, tx, context) => {
      if (!targetLayerId) return;
      const frame = e.activeFrame;
      const canvas = frame.canvas;
      const layer = frame.layers.byId[targetLayerId];
      if (!layer) return;

      // Minimum size constraint
      const minW = 40;
      const minH = Math.max(20, (layer.textData?.fontSize || 24) * (layer.textData?.lineHeight || 1.4));
      const finalW = Math.max(minW, newRect.w);
      const finalH = Math.max(minH, newRect.h);

      // Recover the new world centre.
      let newCx: number;
      let newCy: number;

      if (context.orientation && startCenter && startLocalRect) {
        // Orientation-aware path: newRect is in the layer's LOCAL axes. Recover
        // the world centre via the shared core helper, which uses the renderer's
        // own O = R × F convention (no hand-rolled sin/cos here on purpose).
        const worldCenter = e.geometry.space.localToWorldCenter(
          startCenter,
          startLocalRect,
          { x: newRect.x, y: newRect.y, w: finalW, h: finalH },
          context.orientation
        );
        newCx = worldCenter.x;
        newCy = worldCenter.y;
      } else {
        // Axis-aligned path: canvas-local rect → world cx/cy.
        newCx = newRect.x + finalW / 2 - canvas.w / 2;
        newCy = newRect.y + finalH / 2 - canvas.h / 2;
      }

      tx.update({
        cx: newCx,
        cy: newCy,
        bounding: { w: finalW, h: finalH },
        visibleShape: asLocalShape({ x: 0, y: 0, w: finalW, h: finalH }),
        textData: {
          ...layer.textData!,
          boxMode: 'fixed' as const,
          boxWidth: finalW,
          boxHeight: finalH,
        },
      }, 'layer', targetLayerId);
    },

    onEnd: () => {
      targetLayerId = null;
    },

    onCancel: () => {
      targetLayerId = null;
    },
    // No autoCommit concerns — the framework commits resize completion.
  });
};

// ─── TextRotateHandler ──────────────────────────────────────────────────────────

/**
 * TextRotateHandler: drag the rotation handle to freely rotate the text layer.
 *
 * Priority 165 (> TextResizeHandler 160 > TextPlaceHandler 150): a pointerdown
 * on the rotate handle must win over resize / place. Gated to text craft
 * pre-edit state; the handle is a DOM dot rendered by LayerOverlay's text
 * gizmo carrying `data-gizmo-rotate`.
 *
 * Math: identical to MarkerRotateHandler — atan2 delta → rotation.
 * Shift → snap to nearest 15°.
 *
 * Non-silent: the rotation lands as its own undoable history step.
 */
export const createTextRotateHandler = (): InteractionHandler => {
  let rotateLayerId: string | null = null;
  let startAngleRad = 0;
  let startRotation = 0;
  let layerCx = 0;
  let layerCy = 0;
  let tx: InteractionTransaction | null = null;

  return {
    id: 'text-rotate',
    priority: 165,

    test: (e) => {
      if (e.state.interaction.interactionMode !== 'craft') return false;
      if (e.state.interaction.signals[ACTIVE_CRAFT_KEY] !== 'text') return false;

      const target = e.nativeEvent.target as HTMLElement;
      if (!target.closest('[data-gizmo-rotate]')) return false;

      const layer = resolveGizmoTargetLayer(e);
      if (!layer) return false;

      rotateLayerId = layer.id;
      return true;
    },

    onStart: (e) => {
      if (!rotateLayerId) return;
      const frame = e.activeFrame;
      const layer = frame.layers.byId[rotateLayerId];
      if (!layer) return;

      layerCx = layer.cx;
      layerCy = layer.cy;
      startRotation = layer.rotation;
      startAngleRad = Math.atan2(
        e.point.world.y - layerCy,
        e.point.world.x - layerCx,
      );

      // Non-silent: own undoable history step (see TextMoveHandler).
      tx = new InteractionTransaction(e);
      tx.begin();
      e.actions.fast.setCursor(ROTATE_CURSOR);
    },

    onMove: (e) => {
      if (!rotateLayerId || !tx) return;

      const currentAngleRad = Math.atan2(
        e.point.world.y - layerCy,
        e.point.world.x - layerCx,
      );

      const deltaDeg = ((currentAngleRad - startAngleRad) * 180) / Math.PI;
      let newRotation = e.geometry.transform.normalizeAngle(startRotation + deltaDeg);

      if ((e.nativeEvent as MouseEvent).shiftKey) {
        newRotation = e.geometry.transform.normalizeAngle(
          e.geometry.transform.snapAngle(startRotation + deltaDeg, 15),
        );
      }

      tx.update({ rotation: newRotation }, 'layer', rotateLayerId);
    },

    onEnd: (e) => {
      if (tx) {
        tx.commit();
        tx = null;
      }
      rotateLayerId = null;
      e.actions.fast.setCursor(null);
    },

    onCancel: () => {
      if (tx) {
        tx.abort();
        tx = null;
      }
      rotateLayerId = null;
    },
  };
};

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
 * TextDblClickEditHandler: Double Click to Edit — in pan mode AND in the text
 * tool's pre-edit state (the two-level click model: single click selects,
 * double click edits).
 *
 * In pan mode, double-clicking a text layer activates the Text Craft tool and
 * enters the inline editing session via `cmd.edit_start` (mirrors
 * Figma/Photoshop behaviour). When the editing session ends the user lands in
 * the text tool's pre-edit state — a further Esc or V is needed to return to
 * pan. Registered by the TextOverlay plugin though it also fires in pan mode:
 * the dispatcher arbitrates all plugins' handlers in one global priority pool,
 * so living here (its behaviour owner) costs nothing and keeps LayerOverlay
 * free of any text knowledge.
 *
 * In text craft mode this handler is what makes double-click edit work under
 * the two-level model: the FIRST click of the pair falls through to
 * text-place (select-only), the SECOND click is claimed here and enters the
 * editing session with the caret at the clicked position.
 *
 * Detection strategy: `test()` only claims the gesture when THIS pointerdown
 * is the second click of a pair (native detail === 2 when the browser reports
 * it, plus a time/distance fallback for browsers that leave pointerdown
 * detail at 0). Every pointerdown updates the tracker, so the FIRST click of
 * the pair falls through to layer-move / text-place untouched. When claimed,
 * the handler consumes the whole gesture (no move/end behaviour), so the
 * second click never starts a layer drag.
 *
 * Priority 175: ABOVE text-move (170) so this handler's test runs on every
 * press — its double-click tracker must see BOTH presses of a pair (the
 * dispatcher short-circuits at the first passing handler, so a tracker living
 * below move would miss the first press once move started claiming text-layer
 * presses). Single presses fall through to text-move; the second press of a
 * pair is claimed here. In the EDITING state the gesture is never claimed —
 * double-click inside the live editor is the browser's native word-select.
 */
export const createTextDblClickEditHandler = (): InteractionHandler => {
  // Double-click tracker: last pointerdown time + canvas point. Updated on
  // every pointerdown (test() runs once per gesture start), regardless of
  // whether this handler claims it.
  let lastDownTime = 0;
  let lastDownX = 0;
  let lastDownY = 0;

  const findEditableTextLayerAtPoint = (e: InteractionEvent): Layer | null => {
    const hits = e.geometry.space.pickLayersAt(e.point.world, e.activeFrame.layers);
    return hits.find((l: Layer) => l.type === 'text' && l.visible && !l.locked && !!l.textData) || null;
  };

  const inTextCraft = (e: InteractionEvent): boolean =>
    e.state.interaction.interactionMode === 'craft' &&
    e.state.interaction.signals[ACTIVE_CRAFT_KEY] === 'text';

  return {
    id: 'text-dblclick-edit',
    priority: 175,

    test: (e) => {
      // Pan mode (edit from outside the tool) and text craft pre-edit (the
      // two-level click model) only. Never during a live editing session —
      // double-click inside the editor is the browser's word-select.
      if (e.state.interaction.signals[EDITING_TEXT_KEY]) return false;
      if (e.state.interaction.interactionMode !== 'pan' && !inTextCraft(e)) return false;

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
      return !!findEditableTextLayerAtPoint(e);
    },

    onStart: (e) => {
      const hitTextLayer = findEditableTextLayerAtPoint(e);
      if (!hitTextLayer) return;
      // Hand the double-click point to the inline editor so the caret lands
      // where the user double-clicked instead of at the end of the text.
      const mouseEvent = e.nativeEvent as MouseEvent;
      setPendingEditCaretPoint({ clientX: mouseEvent.clientX, clientY: mouseEvent.clientY });
      // Activate the text tool FIRST so the editing session runs inside the
      // text craft state machine: when the session ends the user lands in
      // the tool's pre-edit state (drawer open, place/move semantics live).
      // Skipped when the text craft is already active — activateCraft is a
      // toggle and would deactivate the tool mid-double-click.
      if (!inTextCraft(e)) {
        e.actions.executeCommand(CraftDrawerAPI.commands.activateText.uid);
      }
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

// ─── TextPlaceHandler ──────────────────────────────────────────────────────────

/** Pointer travel (px, canvas space) below which a press is a click, not a drag. */
const PLACE_DRAG_THRESHOLD_PX = 5;

/** Minimum dragged box width (canvas px) — narrower drags clamp to this. */
const DRAG_MIN_W_PX = 20;

/**
 * TextPlaceHandler: Text placement interaction handler
 *
 * Two-stage click arbitration (Figma-style): while a text layer is being
 * edited, the FIRST canvas click only commits the running session (via the
 * commit-request DOM event the InlineTextEditor listens for) and is consumed;
 * the SECOND click on empty canvas starts creation.
 *
 * Click vs drag: onStart only records the anchor point. A drag ≥ 5px shows a
 * dashed marquee (SIGNAL_PLACE_MARQUEE). On release, a click creates an
 * auto_width point text; a mostly-horizontal drag creates an auto_height
 * paragraph box (locked width, growing height); any two-axis drag creates a
 * fixed box.
 */
export const createTextPlaceHandler = (): InteractionHandler => {
  // Drag gesture state (canvas-local anchor; null = no gesture in progress)
  let startPoint: { x: number; y: number } | null = null;
  let dragging = false;

  /** Reads the user's pre-edit style preset for a new text layer. */
  const readPendingStyle = (e: InteractionEvent) => {
    const craftConfig = e.state.pluginConfig[CraftDrawerAPI.configKey] as
      | { pendingTextData?: PendingTextData }
      | undefined;
    const pending = craftConfig?.pendingTextData;
    const fontSize = pending?.fontSize || getReferenceFontSize(e.activeFrame.canvas.w, e.activeFrame.canvas.h);
    const lineHeight = pending?.lineHeight || TEXT_DEFAULT_LINE_HEIGHT;
    return { pending, fontSize, lineHeight };
  };

  const readPendingColor = (e: InteractionEvent): ColorValue => {
    const colorConfig = e.state.pluginConfig[ColorOptionsAPI.configKey] as { pendingColor?: ColorValue } | undefined;
    return colorConfig?.pendingColor ?? fromHex('#FFFFFF');
  };

  const buildTextLayer = (
    e: InteractionEvent,
    geometry: { cx: number; cy: number; w: number; h: number },
    box: { mode: 'auto_width' | 'auto_height' | 'fixed'; boxWidth?: number; boxHeight?: number },
  ): Layer => {
    const frame = e.activeFrame;
    const { pending, fontSize, lineHeight } = readPendingStyle(e);
    const layersArray = frame.layers.order.map(id => frame.layers.byId[id]);
    return LayerFactory.getNewLayer({
      name: LayerFactory.getNewLayerName(layersArray, 'Text'),
      type: 'text',
      cx: geometry.cx,
      cy: geometry.cy,
      bounding: { w: geometry.w, h: geometry.h },
      visible: true,
      textData: {
        content: '',
        fontFamily: pending?.fontFamily || 'Inter',
        fontSize,
        fontWeight: pending?.fontWeight || 400,
        color: readPendingColor(e),
        align: pending?.align || 'left',
        lineHeight,
        letterSpacing: pending?.letterSpacing || 0,
        verticalAlign: pending?.verticalAlign || 'top',
        italic: pending?.italic || false,
        underline: pending?.underline || false,
        strikethrough: pending?.strikethrough || false,
        boxMode: box.mode,
        boxWidth: box.boxWidth,
        boxHeight: box.boxHeight,
      },
    });
  };

  /** Click (< 5px travel): caret-anchored auto_width point text. */
  const createPointText = (e: InteractionEvent, point: { x: number; y: number }) => {
    const frame = e.activeFrame;
    const { fontSize, lineHeight } = readPendingStyle(e);
    const initH = getInitialLineBoxHeight(fontSize, lineHeight);
    // Caret-anchored placement: inside the editor, contenteditable has
    // padding-left: TEXT_LAYER_PADDING.x (4px). To align the initial flashing
    // caret (instead of the outer dashed border) precisely under the pointer,
    // offset the box origin leftward by the horizontal padding.
    const boxLocalX = Math.max(0, point.x - TEXT_LAYER_PADDING.x);
    const initW = getInitialPointTextBoxWidth(frame.canvas.w - boxLocalX);
    // Convert boxLocalX to world space so snapRectToPixel and cx/cy aren't
    // shifted by (+canvas.w/2, +canvas.h/2).
    const worldPoint = e.geometry.space.localToWorld(boxLocalX, point.y, frame);
    const alignedRect = e.geometry.snapping.snapRectToPixel(
      asWorldRect({ x: worldPoint.x, y: worldPoint.y - initH / 2, w: initW, h: initH }),
      frame.canvas
    );
    const center = e.geometry.space.getRectCenter(alignedRect);
    const layer = buildTextLayer(
      e,
      { cx: center.x, cy: center.y, w: initW, h: initH },
      { mode: 'auto_width' },
    );
    e.actions.executeCommand(CMD_PLACE_UID, { frameId: frame.id, layer });
  };

  /** Drag (≥ 5px travel): marquee rect → auto_height / fixed paragraph box. */
  const createDraggedBox = (e: InteractionEvent, start: { x: number; y: number }, end: { x: number; y: number }) => {
    const frame = e.activeFrame;
    const { fontSize, lineHeight } = readPendingStyle(e);
    const lineH = getInitialLineBoxHeight(fontSize, lineHeight);

    const dx = Math.abs(end.x - start.x);
    const dy = Math.abs(end.y - start.y);
    const w = Math.max(DRAG_MIN_W_PX, Math.round(dx));
    // Horizontal-only drag → auto_height (height grows with lines); any
    // significant vertical travel → fixed box clipped to the dragged height.
    const isHorizontal = dy < PLACE_DRAG_THRESHOLD_PX;
    const h = isHorizontal ? lineH : Math.max(lineH, Math.round(dy));

    const rectX = Math.min(start.x, end.x);
    const rectY = Math.min(start.y, end.y);
    // Pixel alignment: snap the dragged size, keep the centre on the pointer path.
    const cx = rectX + w / 2;
    const cy = rectY + h / 2;
    const worldCenter = e.geometry.space.localToWorld(cx, cy, frame);

    const layer = buildTextLayer(
      e,
      { cx: worldCenter.x, cy: worldCenter.y, w, h },
      isHorizontal
        ? { mode: 'auto_height', boxWidth: w }
        : { mode: 'fixed', boxWidth: w, boxHeight: h },
    );
    e.actions.executeCommand(CMD_PLACE_UID, { frameId: frame.id, layer });
  };

  const clearMarquee = (e: InteractionEvent) => {
    e.actions.fast.setTransient(TEXT_PLACE_MARQUEE_TRANSIENT_KEY, null);
  };

  return {
    id: 'text-place',
    priority: 150,

    test: (e) => {
      // Only active in craft mode and activeCraft === 'text'
      if (e.state.interaction.interactionMode !== 'craft') return false;
      if (e.state.interaction.signals[ACTIVE_CRAFT_KEY] !== 'text') return false;

      // Exclude UI element clicks, the live editor, and gizmo handles
      const target = e.nativeEvent.target as HTMLElement;
      if (target.closest('button, a, input, [data-role="ui"], [contenteditable], [data-handle], [data-gizmo-handle], [data-gizmo-rotate]')) return false;

      // Click within canvas range
      const frame = e.activeFrame;
      return e.geometry.space.isPointInRect(e.point.canvas, {
        x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h,
      });
    },

    onStart: (e) => {
      const frame = e.activeFrame;

      // ── Two-stage click arbitration ──
      // A session is running: this click only commits it and is consumed —
      // creating a box on the same click would throw away the caret focus the
      // user just finished with. The editor owns commit; this handler only
      // requests it. (NOT silent-creating a layer here.)
      if (e.state.interaction.signals[EDITING_TEXT_KEY]) {
        window.dispatchEvent(new CustomEvent(TEXT_OVERLAY_EVT_COMMIT_REQUEST));
        return;
      }

      // Clicking an existing text layer = SELECT only (Figma two-level
      // model): the pre-edit frame's handles go live on it immediately, so
      // resize/rotate/move need no detour through an editing session.
      // Double-click enters editing via text-dblclick-edit.
      const hitTextLayer = findTextLayerAtPoint(e.geometry, frame, e.point.canvas);
      if (hitTextLayer) {
        e.actions.setActiveLayer(frame.id, hitTextLayer.id);
        return;
      }

      // Empty canvas: record the anchor only — click vs drag is decided at
      // onEnd so the marquee can preview the dragged box.
      startPoint = { x: e.point.canvas.x, y: e.point.canvas.y };
      dragging = false;
    },

    onMove: (e) => {
      if (!startPoint) return;
      const dx = e.point.canvas.x - startPoint.x;
      const dy = e.point.canvas.y - startPoint.y;
      if (!dragging && Math.hypot(dx, dy) < PLACE_DRAG_THRESHOLD_PX) return;
      dragging = true;

      const rect: PlaceMarqueeRect = {
        x: Math.min(startPoint.x, e.point.canvas.x),
        y: Math.min(startPoint.y, e.point.canvas.y),
        w: Math.abs(dx),
        h: Math.abs(dy),
      };
      // Volatile fast track, NOT a store signal: the marquee updates at
      // pointermove rate, and a Redux dispatch here re-renders the whole tree
      // per move — sustained 60 Hz drags drive React's nested-update counter
      // past its limit on heavy documents ("Maximum update depth exceeded").
      e.actions.fast.setTransient(TEXT_PLACE_MARQUEE_TRANSIENT_KEY, rect);
    },

    onEnd: (e) => {
      if (!startPoint) return; // arbitration or edit-start consumed the gesture
      const start = startPoint;
      startPoint = null;
      clearMarquee(e);

      if (dragging) {
        dragging = false;
        createDraggedBox(e, start, { x: e.point.canvas.x, y: e.point.canvas.y });
      } else {
        createPointText(e, start);
      }
    },

    onCancel: (e) => {
      startPoint = null;
      dragging = false;
      clearMarquee(e);
    },
  };
};
