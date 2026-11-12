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

import { InteractionHandler, InteractionEvent, Layer, asWorldRect } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { CraftDrawerAPI, getReferenceFontSize } from '../../../drawers/CraftDrawer/protocols';
import type { PendingTextData } from '../../../drawers/CraftDrawer/protocols';
import { getInitialLineBoxHeight, getInitialPointTextBoxWidth } from '../geometry';
import { TEXT_OVERLAY_EVT_COMMIT_REQUEST, TEXT_PLACE_MARQUEE_TRANSIENT_KEY } from '../protocols';
import type { PlaceMarqueeRect } from '../protocols';
import { ColorOptionsAPI } from '../../../options/ColorOptions/protocols';
import { fromHex, type ColorValue } from '@opengpex/editor/core/engine/color';
import { TEXT_DEFAULT_LINE_HEIGHT, TEXT_STYLE_DEFAULTS } from '../hooks/styling';
import {
  ACTIVE_CRAFT_KEY,
  CMD_PLACE_UID,
  EDITING_TEXT_KEY,
  findTextLayerAtPoint,
} from './shared';

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
    // The pending colour is a FOREGROUND colour (same semantics as the fill's):
    // a layer's own opacity governs its coverage, so a persisted alpha — e.g. an
    // eyedropper sample over a transparent region landing on alpha 0 — must not
    // leak into new text and render it invisible (2026-11-12 finding).
    const color = colorConfig?.pendingColor ?? fromHex('#FFFFFF');
    return { ...color, alpha: 1 };
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
        fontFamily: pending?.fontFamily || TEXT_STYLE_DEFAULTS.fontFamily,
        fontSize,
        fontWeight: pending?.fontWeight || TEXT_STYLE_DEFAULTS.fontWeight,
        color: readPendingColor(e),
        align: pending?.align || TEXT_STYLE_DEFAULTS.align,
        lineHeight,
        letterSpacing: pending?.letterSpacing || TEXT_STYLE_DEFAULTS.letterSpacing,
        verticalAlign: pending?.verticalAlign || TEXT_STYLE_DEFAULTS.verticalAlign,
        italic: pending?.italic || TEXT_STYLE_DEFAULTS.italic,
        underline: pending?.underline || TEXT_STYLE_DEFAULTS.underline,
        strikethrough: pending?.strikethrough || TEXT_STYLE_DEFAULTS.strikethrough,
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
    // Caret-anchored placement: inside the editor the content sits flush with
    // the box edge (no padding), so the initial flashing caret lands directly
    // under the pointer with no extra offset.
    const boxLocalX = Math.max(0, point.x);
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
      if (target.closest('button, a, input, [data-role="ui"], [contenteditable], [data-handle], [data-text-gizmo] [data-gizmo-handle], [data-text-gizmo] [data-gizmo-rotate]')) return false;

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

      // Non-editable text layers (locked / hidden) only — every EDITABLE
      // text layer press is claimed above by text-move (bare press = enter
      // editing, spring press = move), so this branch selects what the move
      // handler deliberately passes over and never creates on top of text.
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
