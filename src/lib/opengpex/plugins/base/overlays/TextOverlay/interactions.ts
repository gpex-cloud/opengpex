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
import { ROTATE_CURSOR } from '@opengpex/editor/icons';
import { TEXT_LAYER_PADDING } from '@opengpex/editor/core/helpers/config';
import { CraftDrawerAPI, getReferenceFontSize, getInitialTextBoxSize, TEXT_DEFAULT_LINE_HEIGHT } from '../../drawers/CraftDrawer/protocols';
import type { PendingTextData } from '../../drawers/CraftDrawer/protocols';
import { TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, TEXT_BORDER_BAND_RATIO, _CMD_PLACE_UID, _CMD_EDIT_START_UID } from './protocols';
import { TEXT_OVERLAY_SIGNAL_PLACE_MARQUEE, TEXT_OVERLAY_EVT_COMMIT_REQUEST } from './protocols';
import type { PlaceMarqueeRect } from './protocols';
import { ColorOptionsAPI } from '../../options/ColorOptions/protocols';
import { fromHex, type ColorValue } from '@opengpex/editor/core/engine/color';
import { setPendingEditCaretPoint } from './editCaret';

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
 */
function findTextLayerAtPoint(geometry: GeometryService, frame: Frame, point: { x: number; y: number }): Layer | null {
  const worldPoint = geometry.space.localToWorld(point.x, point.y, frame);
  const hits = geometry.space.pickLayersAt(worldPoint, frame.layers);
  return hits.find((l: Layer) => l.type === 'text') || null;
}

/**
 * Whether the pointer sits in the border band of the given layer. The band is
 * proportional to the box's min side (TEXT_BORDER_BAND_RATIO) and straddles
 * the border: 2/3 of its thickness outside the rect, 1/3 inside — hit-testing
 * is the ring between the rect grown by the outward part and the rect shrunk
 * by the inward part. Axis-aligned canvas-space approximation, consistent with
 * the rest of this handler's rect math. Handles are excluded by the callers —
 * this only answers "is it the border".
 */
export function isPointInLayerBorderBand(layer: Layer, frame: Frame, p: { x: number; y: number }): boolean {
  const band = Math.min(layer.bounding.w, layer.bounding.h) * TEXT_BORDER_BAND_RATIO;
  const outward = (band * 2) / 3;
  const inward = band / 3;
  const rectX = frame.canvas.w / 2 + layer.cx - layer.bounding.w / 2;
  const rectY = frame.canvas.h / 2 + layer.cy - layer.bounding.h / 2;
  const rectW = layer.bounding.w;
  const rectH = layer.bounding.h;

  const inOuter = p.x >= rectX - outward && p.x <= rectX + rectW + outward
    && p.y >= rectY - outward && p.y <= rectY + rectH + outward;
  if (!inOuter) return false;

  const inInner = p.x >= rectX + inward && p.x <= rectX + rectW - inward
    && p.y >= rectY + inward && p.y <= rectY + rectH - inward;
  return !inInner;
}

// ─── TextMoveHandler ───────────────────────────────────────────────────────────

/**
 * TextMoveHandler: Cmd/Ctrl + drag to move text layer
 *
 * In text craft mode (regardless of entering editing state), hold Meta/Ctrl key
 * and drag an existing text layer to move its position. Without a modifier the
 * editing-state box belongs entirely to caret placement / text selection (the
 * editing-state border-band drag path was removed); in the PRE-editing state a
 * plain drag on the border band still moves the layer.
 *
 * Design considerations:
 * - Does not trigger entering/exiting editing state
 * - Cursor position remains after moving in editing state (only changes cx/cy)
 * - Independent undoable transaction: tx.begin() creates its own history step
 *   that lands immediately at drag end (NOT silent) — a deliberate geometry
 *   move is an undoable edit in its own right, ordered before the session's
 *   CMD_MODIFY_COMMIT when both happen during one editing session.
 */
export const createTextMoveHandler = (): InteractionHandler => {
  let startCanvas = { x: 0, y: 0 };
  let startLayerPos = { x: 0, y: 0 };
  let targetLayerId: string | null = null;
  let tx: InteractionTransaction | null = null;

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
      // become a move — with or without Cmd.
      if (target.closest('[data-gizmo-handle], [data-gizmo-rotate]')) return false;

      // Case 1: Layer being edited -> use as target directly.
      // Editing state: ONLY Cmd/Ctrl + drag moves the layer. Every plain
      // mousedown in the box — border band included — stays with the
      // contenteditable (caret placement / text selection); border-band drag
      // while typing was removed as a mis-drag source. Pre-edit band drag is
      // Case 2 below.
      const editingId = e.state.interaction.signals[EDITING_TEXT_KEY] as string | null;
      if (editingId) {
        targetLayerId = editingId;
        return mouseEvent.metaKey || mouseEvent.ctrlKey;
      }

      // Case 2: Pre-editing state.
      // - Cmd/Ctrl + drag anywhere over a text layer (existing behaviour)
      // - plain drag on the border band of a text layer (topmost wins);
      //   the interior without Cmd falls through to the place handler
      //   (click empty canvas to create / wake editing).
      const hasCmd = mouseEvent.metaKey || mouseEvent.ctrlKey;
      if (hasCmd) {
        const hitLayer = findTextLayerAtPoint(e.geometry, e.activeFrame, e.point.canvas);
        if (hitLayer) {
          targetLayerId = hitLayer.id;
          return true;
        }
        return false;
      }
      const order = e.activeFrame.layers.order;
      for (let i = order.length - 1; i >= 0; i--) {
        const layer = e.activeFrame.layers.byId[order[i]];
        if (!layer || layer.type !== 'text' || !layer.visible) continue;
        if (isPointInLayerBorderBand(layer, e.activeFrame, e.point.canvas)) {
          targetLayerId = layer.id;
          return true;
        }
      }

      return false;
    },

    onStart: (e) => {
      if (!targetLayerId) return;
      const frame = e.activeFrame;
      const layer = frame.layers.byId[targetLayerId];
      if (!layer) return;

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
      if (tx) {
        tx.commit();
        tx = null;
      }
      targetLayerId = null;

      // If still holding Cmd/Ctrl when drag ends, restore to grab, otherwise reset to null
      // (the border-band hover cursor re-evaluates on the next mousemove).
      const stillHoldingCmd = e.keys.meta;
      e.actions.fast.setCursor(stillHoldingCmd ? 'grab' : null);
    },
  };
};

// ─── TextResizeHandler ─────────────────────────────────────────────────────────

/**
 * Resolves the text layer a transform-gizmo handle belongs to. The pre-edit
 * gizmo is rendered inside LayerOverlayItem wrapped in an element carrying
 * `data-overlay-gizmo-layer=<layerId>`, so the hit DOM node identifies the target
 * unambiguously (the editing-state gizmo was removed with the session-gizmo
 * split — geometry changes happen either pre-edit here or via Cmd+Drag move).
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
 * data-gizmo-handle attribute (the gizmo is rendered by LayerOverlay for the
 * force-shown text layer), using createTransformHandler factory to implement
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

// ─── TextPlaceHandler ──────────────────────────────────────────────────────────

/** Pointer travel (px, canvas space) below which a press is a click, not a drag. */
const PLACE_DRAG_THRESHOLD_PX = 5;

/** Minimum box width for a click-created point text (just enough for the caret). */
const POINT_TEXT_MIN_W_PX = 10;

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
    const initH = getInitialTextBoxSize(fontSize, lineHeight, frame.canvas.w).h;
    // Caret-anchored placement: inside the editor, contenteditable has
    // padding-left: TEXT_LAYER_PADDING.x (4px). To align the initial flashing
    // caret (instead of the outer dashed border) precisely under the pointer,
    // offset the box origin leftward by the horizontal padding.
    const boxLocalX = Math.max(0, point.x - TEXT_LAYER_PADDING.x);
    const initW = Math.max(
      POINT_TEXT_MIN_W_PX,
      Math.min(Math.round(fontSize * 1.5), frame.canvas.w - boxLocalX),
    );
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
    const lineH = getInitialTextBoxSize(fontSize, lineHeight, frame.canvas.w).h;

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
    e.actions.setStateSignal(TEXT_OVERLAY_SIGNAL_PLACE_MARQUEE, null);
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

      // Clicking an existing text layer -> wake up editing
      const hitTextLayer = findTextLayerAtPoint(e.geometry, frame, e.point.canvas);
      if (hitTextLayer) {
        // Hand the click point to the inline editor so the caret lands where
        // the user clicked instead of at the end of the text.
        const mouseEvent = e.nativeEvent as MouseEvent;
        setPendingEditCaretPoint({ clientX: mouseEvent.clientX, clientY: mouseEvent.clientY });
        // Enter editing state via command system (automatically establish undo baseline)
        e.actions.executeCommand(CMD_EDIT_START_UID, {
          frameId: frame.id,
          layerId: hitTextLayer.id,
        });
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
      e.actions.setStateSignal(TEXT_OVERLAY_SIGNAL_PLACE_MARQUEE, rect);
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
