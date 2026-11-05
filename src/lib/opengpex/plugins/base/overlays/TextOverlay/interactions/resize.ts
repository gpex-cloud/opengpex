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

import { InteractionHandler, LocalRect, asLocalShape } from '@opengpex/editor/core/types';
import type { TextLayerData } from '@opengpex/editor/core/types/models';
import { normalizeBoxMode } from '@opengpex/editor/core/types/models';
import { createTransformHandler, ResizeHandle } from '@opengpex/editor/stage/interaction/handlers/TransformHandler';
import { ACTIVE_CRAFT_KEY, resolveGizmoTargetLayer } from './shared';
import { TEXT_DEFAULT_LINE_HEIGHT } from '../hooks/styling';

// ─── Gesture classification & box semantics ───────────────────────────────────

const CORNER_HANDLES: ReadonlySet<string> = new Set(['nw', 'ne', 'sw', 'se']);

/** Hard floor for the scaled font size on a corner (proportional) drag. */
const TEXT_RESIZE_MIN_FONT_SIZE = 4;

/** Minimum width floor of a text resize gesture (both gesture kinds). */
const TEXT_RESIZE_MIN_W = 40;

/**
 * Classifies a resize gesture and derives the textData patch that expresses
 * its box semantics. Two gesture kinds, with deliberately different contracts:
 *
 * - Corner handles (nw/ne/sw/se) are a PROPORTIONAL SCALE transform. The
 *   framework runs them aspect-locked, and the font size scales with the box
 *   so the text itself grows and shrinks with the drag. A scale changes size,
 *   not box semantics: the current boxMode is preserved untouched, and the
 *   boxWidth/boxHeight locks are left alone for auto modes (fixed boxes get
 *   their locked dimensions scaled along with everything else).
 * - Edge handles (n/s/e/w) are an explicit declaration that the dragged axis
 *   is now USER-OWNED: the layer switches to fixed and only the dragged axis
 *   is recorded as a lock (an e/w drag stamps boxWidth, an n/s drag stamps
 *   boxHeight). The untouched axis keeps whatever lock state it had.
 *
 * Pure and exported for the gesture-contract test suite — onUpdate applies
 * exactly what this returns, so the assertions there cover the live path.
 */
export function resolveTextResizePatch(opts: {
  handle: ResizeHandle;
  /** Bounding at gesture start (the aspect + scale reference). */
  startBounding: { w: number; h: number };
  /** Font size at gesture start (the scale reference). */
  startFontSize: number;
  lineHeight: number;
  /** Resized rect for this frame, already clamped to the minimum floors. */
  rect: { w: number; h: number };
  /** Current textData the patch merges into. */
  textData: TextLayerData;
}): { w: number; h: number; fontSize: number; textData: TextLayerData } {
  const isCorner = CORNER_HANDLES.has(opts.handle);
  const lineHeight = opts.lineHeight || TEXT_DEFAULT_LINE_HEIGHT;

  if (isCorner) {
    // Proportional scale: the rect arrives aspect-locked (getConstraints
    // forces the start ratio for corner handles), so either axis gives the
    // same scale factor. Re-clamp the height against the scaled font's own
    // line-box floor so a heavy shrink cannot go below one visible line.
    const scale = opts.rect.w / opts.startBounding.w;
    const fontSize = Math.max(TEXT_RESIZE_MIN_FONT_SIZE, opts.startFontSize * scale);
    const h = Math.max(20, fontSize * lineHeight, opts.rect.h);
    const textData: TextLayerData = { ...opts.textData, fontSize };
    if (normalizeBoxMode(opts.textData.boxMode) === 'fixed') {
      textData.boxWidth = opts.rect.w;
      textData.boxHeight = h;
    }
    return { w: opts.rect.w, h, fontSize, textData };
  }

  // Edge drag: the dragged axis becomes an explicit user lock.
  const widthAxis = opts.handle === 'e' || opts.handle === 'w';
  const h = Math.max(20, lineHeight * fontSizeOf(opts.textData), opts.rect.h);
  const textData: TextLayerData = {
    ...opts.textData,
    boxMode: 'fixed',
    boxWidth: widthAxis ? opts.rect.w : opts.textData.boxWidth,
    boxHeight: widthAxis ? opts.textData.boxHeight : h,
  };
  return { w: widthAxis ? opts.rect.w : opts.startBounding.w, h, fontSize: fontSizeOf(opts.textData), textData };
}

function fontSizeOf(td: TextLayerData): number {
  return td.fontSize || 24;
}

// ─── TextResizeHandler ─────────────────────────────────────────────────────────

/**
 * TextResizeHandler: pre-edit text box resize interaction handler
 *
 * Active in text craft pre-edit state, identifying drag direction via
 * data-gizmo-handle attribute (the handles are the corner brackets / edge
 * ticks of TextOverlay's own PreEditFrame), using createTransformHandler
 * factory to implement standard 8-direction resizing. The two gesture kinds
 * carry different box semantics (see resolveTextResizePatch): corner drags
 * are an aspect-locked proportional scale that keeps the current boxMode,
 * edge drags declare the dragged axis as a user lock and switch to fixed.
 * Non-silent: the resize lands as its own undoable history step.
 */
export const createTextResizeHandler = (): InteractionHandler => {
  // Orientation-aware resize snapshot (non-null only for rotated/mirrored text):
  // the world centre and the local-axes rect at gesture start, used to map the
  // local resize result back to world cx/cy. Mirrors MarkerOverlay's handler.
  let startCenter: { cx: number; cy: number } | null = null;
  let startLocalRect: { x: number; y: number; w: number; h: number } | null = null;
  let targetLayerId: string | null = null;
  // Gesture-start snapshot for the box-semantics decision: the handle kind and
  // the start bounding / font size that corner drags scale against. Captured
  // once per gesture (test + getInitialState) — reading the live layer later
  // would let the ratio drift while the drag updates the bounding itself.
  let gestureHandle: ResizeHandle | null = null;
  let gestureStart: { w: number; h: number; fontSize: number; lineHeight: number } | null = null;

  return createTransformHandler({
    id: 'text-resize',
    priority: 160,

    test: (e) => {
      // Must be in text craft mode (the gizmo is force-shown only there)
      if (e.state.interaction.interactionMode !== 'craft') return null;
      if (e.state.interaction.signals[ACTIVE_CRAFT_KEY] !== 'text') return null;

      // Only responds to resize handle clicks
      const target = e.nativeEvent.target as HTMLElement;
      if (!target.closest('[data-text-gizmo] [data-gizmo-handle]')) return null;

      const handleEl = target.closest('[data-text-gizmo] [data-gizmo-handle]') as HTMLElement;
      const handleType = handleEl.dataset.gizmoHandle;
      // Exclude 'move' (clicks inside the box fall through to other handlers)
      if (!handleType || handleType === 'move') return null;

      const layer = resolveGizmoTargetLayer(e);
      if (!layer) return null;
      targetLayerId = layer.id;
      gestureHandle = handleType as ResizeHandle;

      return { category: 'resize', handle: handleType as ResizeHandle };
    },

    getInitialState: (e) => {
      const frame = e.activeFrame;
      const layer = targetLayerId ? frame.layers.byId[targetLayerId] : null;
      if (!layer) return { x: 0, y: 0, w: 0, h: 0 } as LocalRect;
      const canvas = frame.canvas;

      // Snapshot the scale reference for corner drags once, at gesture start.
      gestureStart = {
        w: layer.bounding.w,
        h: layer.bounding.h,
        fontSize: layer.textData?.fontSize || 24,
        lineHeight: layer.textData?.lineHeight || TEXT_DEFAULT_LINE_HEIGHT,
      };

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

    // Corner handles are always a proportional scale transform, so they run
    // aspect-locked at the gesture-start ratio (Shift is then a no-op). Edge
    // handles stay free on their single axis — that freedom IS the explicit
    // "fix this axis" declaration the edge branch records.
    getConstraints: () => {
      const isCorner = gestureHandle !== null && CORNER_HANDLES.has(gestureHandle);
      const ratio = gestureStart && gestureStart.h > 0 ? gestureStart.w / gestureStart.h : undefined;
      return {
        aspect: isCorner ? ratio : undefined,
        clamp: false,
      };
    },

    onUpdate: (e, newRect, tx, context) => {
      if (!targetLayerId || !gestureStart || !gestureHandle) return;
      const frame = e.activeFrame;
      const canvas = frame.canvas;
      const layer = frame.layers.byId[targetLayerId];
      if (!layer || !layer.textData) return;

      // Minimum width constraint (the height floor lives inside the patch
      // resolver, tied to the scaled font's own line box).
      const finalW = Math.max(TEXT_RESIZE_MIN_W, newRect.w);

      const patch = resolveTextResizePatch({
        handle: gestureHandle,
        startBounding: { w: gestureStart.w, h: gestureStart.h },
        startFontSize: gestureStart.fontSize,
        lineHeight: gestureStart.lineHeight,
        rect: { w: finalW, h: newRect.h },
        textData: layer.textData,
      });

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
          { x: newRect.x, y: newRect.y, w: patch.w, h: patch.h },
          context.orientation
        );
        newCx = worldCenter.x;
        newCy = worldCenter.y;
      } else {
        // Axis-aligned path: canvas-local rect → world cx/cy.
        newCx = newRect.x + patch.w / 2 - canvas.w / 2;
        newCy = newRect.y + patch.h / 2 - canvas.h / 2;
      }

      tx.update({
        cx: newCx,
        cy: newCy,
        bounding: { w: patch.w, h: patch.h },
        visibleShape: asLocalShape({ x: 0, y: 0, w: patch.w, h: patch.h }),
        textData: patch.textData,
      }, 'layer', targetLayerId);
    },

    onEnd: () => {
      targetLayerId = null;
      gestureHandle = null;
      gestureStart = null;
    },

    onCancel: () => {
      targetLayerId = null;
      gestureHandle = null;
      gestureStart = null;
    },
    // No autoCommit concerns — the framework commits resize completion.
  });
};
