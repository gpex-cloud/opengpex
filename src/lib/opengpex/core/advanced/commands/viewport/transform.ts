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

import { EditorCommand, EditorContextValue, Frame, Point2D } from '@opengpex/editor/core/types';
import * as P from '@opengpex/editor/core/advanced/protocols';
import { remapDraftsForPivotRotation, remapDraftsForViewportOp } from '@opengpex/editor/core/state/drafts';
import { getStraightenPivot, STRAIGHTEN_TRANSIENT_KEY } from '@opengpex/editor/core/state/volatile/straighten';

export const ViewportTransformCommands = {
  rotate: {
    id: P.ADV_VIEWPORT_ROTATE,
    name: 'Rotate Frame',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { direction: 'left' | 'right' }): void => {
      const { activeFrame, actions, geometry } = ctx;
      if (!activeFrame) return;

      actions.fast.reset();

      const operation = payload.direction === 'right' ? 'rotate_r' : 'rotate_l';
      const nextFramePatch = geometry.transform.transformFrame(activeFrame, operation, remapDraftsForViewportOp(operation));

      actions.updateFrame(activeFrame.id, {
        ...nextFramePatch,
        confinement: nextFramePatch.confinement,
        canvasClipBox: nextFramePatch.canvasClipBox,
        imageAspect: activeFrame.imageAspect ? 1 / activeFrame.imageAspect : undefined,
        canvasAspect: activeFrame.canvasAspect ? 1 / activeFrame.canvasAspect : undefined
      });
    }
  } as EditorCommand<{ direction: 'left' | 'right' }, void>,

  rotateLeft: {
    id: P.ADV_VIEWPORT_ROTATE_LEFT,
    name: 'Rotate Left',
    undoable: true,
    execute: (ctx: EditorContextValue) => ViewportTransformCommands.rotate.execute(ctx, { direction: 'left' }),
    // shortcuts: [{ key: '{', shift: true }]
    // ↑ Dormant: Shift+[ ({) reassigned to brush hardness (Photoshop convention).
    //   Canvas rotation should use R-tool + drag in the future.
  } as EditorCommand<void, void>,

  rotateRight: {
    id: P.ADV_VIEWPORT_ROTATE_RIGHT,
    name: 'Rotate Right',
    undoable: true,
    execute: (ctx: EditorContextValue) => ViewportTransformCommands.rotate.execute(ctx, { direction: 'right' }),
    // shortcuts: [{ key: '}', shift: true }]
    // ↑ Dormant: Shift+] (}) reassigned to brush hardness (Photoshop convention).
    //   Canvas rotation should use R-tool + drag in the future.
  } as EditorCommand<void, void>,

  flip: {
    id: P.ADV_VIEWPORT_FLIP,
    name: 'Flip Frame',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { direction: 'horizontal' | 'vertical' }): void => {
      const { activeFrame, actions, geometry } = ctx;
      if (!activeFrame) return;

      actions.fast.reset();

      const operation = payload.direction === 'horizontal' ? 'flip_h' : 'flip_v';
      const nextFramePatch = geometry.transform.transformFrame(activeFrame, operation, remapDraftsForViewportOp(operation));

      actions.updateFrame(activeFrame.id, {
        ...nextFramePatch,
        confinement: nextFramePatch.confinement,
        canvasClipBox: nextFramePatch.canvasClipBox,
      });
    }
  } as EditorCommand<{ direction: 'horizontal' | 'vertical' }, void>,

  flipH: {
    id: P.ADV_VIEWPORT_FLIP_H,
    name: 'Flip Horizontal',
    category: 'View',
    undoable: true,
    execute: (ctx: EditorContextValue) => ViewportTransformCommands.flip.execute(ctx, { direction: 'horizontal' }),
    shortcuts: [{ key: 'h', shift: true }]
  } as EditorCommand<void, void>,

  flipV: {
    id: P.ADV_VIEWPORT_FLIP_V,
    name: 'Flip Vertical',
    category: 'View',
    undoable: true,
    execute: (ctx: EditorContextValue) => ViewportTransformCommands.flip.execute(ctx, { direction: 'vertical' }),
    shortcuts: [{ key: 'v', shift: true }]
  } as EditorCommand<void, void>,

  reset: {
    id: P.ADV_VIEWPORT_RESET,
    name: 'Reset Transform',
    category: 'View',
    undoable: true,
    execute: (ctx: EditorContextValue): void => {
      const { activeFrame, actions, geometry } = ctx;
      if (!activeFrame) return;

      actions.fast.reset();

      const baseLayer = activeFrame.layers.byId[activeFrame.layers.order[0]];
      if (!baseLayer) return;

      let nextFrame: Frame = activeFrame;

      // Undo the CANVAS TRANSFORM (±90 rotations + flips) ONLY — the content
      // straighten has its own affordance (the straighten control's
      // double-click / type-0), and this button's whole identity (the Monitor
      // icon animates from frame.rotation + flips) is the canvas transform.
      // frame.rotation is THE canvas-transform record (transformFrame accumulates
      // exactly ±90 per step) — reading it instead of inferring from the
      // base layer's rotation keeps the reset correct when free angles (or
      // user gizmo rotations) are mixed into the layer poses.
      const currentRot = (((nextFrame.rotation || 0) % 360) + 360) % 360;

      if (currentRot === 90) {
        nextFrame = { ...nextFrame, ...geometry.transform.transformFrame(nextFrame, 'rotate_l', remapDraftsForViewportOp('rotate_l')) };
      } else if (currentRot === 180) {
        nextFrame = { ...nextFrame, ...geometry.transform.transformFrame(nextFrame, 'rotate_l', remapDraftsForViewportOp('rotate_l')) };
        nextFrame = { ...nextFrame, ...geometry.transform.transformFrame(nextFrame, 'rotate_l', remapDraftsForViewportOp('rotate_l')) };
      } else if (currentRot === 270) {
        nextFrame = { ...nextFrame, ...geometry.transform.transformFrame(nextFrame, 'rotate_r', remapDraftsForViewportOp('rotate_r')) };
      }

      // Undo the canvas-transform flips (frame-level ops recorded in the base
      // layer's flip flags — no frame-level field exists; same heuristic
      // as before).
      const currentBase = nextFrame.layers.byId[nextFrame.layers.order[0]];
      if (currentBase.flip.h) {
        nextFrame = { ...nextFrame, ...geometry.transform.transformFrame(nextFrame, 'flip_h', remapDraftsForViewportOp('flip_h')) };
      }
      if (currentBase.flip.v) {
        nextFrame = { ...nextFrame, ...geometry.transform.transformFrame(nextFrame, 'flip_v', remapDraftsForViewportOp('flip_v')) };
      }

      actions.updateFrame(activeFrame.id, {
        canvas: nextFrame.canvas,
        rotation: 0,
        layers: nextFrame.layers,
        confinement: nextFrame.confinement,
        canvasClipBox: nextFrame.canvasClipBox,
        camera: nextFrame.camera,
        drafts: nextFrame.drafts,
      });
    },
    shortcuts: [{ key: 'r', meta: true, alt: true }, { key: 'r', ctrl: true, alt: true }]
  } as EditorCommand<void, void>,

  /**
   * Canvas STRAIGHTEN — commits a free-angle rotation as a one-step
   * materialization: every layer pose and the selection are rewritten about
   * the effective clip-rect center by `straightenFrame` (pure record
   * rewrite, zero resampling), the drag preview transient is cleared, and
   * the whole patch lands in ONE undoable updateFrame. `frame.rotation` is
   * deliberately untouched — it is the CANVAS TRANSFORM field the swapRotate
   * DOM compensation listens to; a free-angle delta there would trigger a
   * spurious reverse compensation.
   */
  straighten: {
    id: P.ADV_VIEWPORT_STRAIGHTEN,
    name: 'Straighten',
    category: 'View',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { thetaDeg: number }): void => {
      const { activeFrame, actions, geometry } = ctx;
      if (!activeFrame) return;
      // Kill the preview first: the materialized frame and the preview show
      // the identical picture (same pivot map), so there is no flash either way.
      actions.fast.setTransient(STRAIGHTEN_TRANSIENT_KEY, null);
      if (!payload?.thetaDeg) return;

      actions.fast.reset();

      // ── Record-rewrite orchestration (inlined: this IS the command body —
      // a free-angle materialization has exactly one consumer, so it must not
      // live as a "function" in any shared layer) ──
      const thetaDeg = payload.thetaDeg;
      const pivot = getStraightenPivot(activeFrame);
      const remapDrafts = remapDraftsForPivotRotation({ pivot, thetaDeg });
      // POSE space has its origin at the CANVAS CENTER
      // — confinement and drafts live in top-left canvas space and keep the
      // top-left pivot; the pose map must use the converted one.
      const pivotPose = { x: pivot.x - activeFrame.canvas.w / 2, y: pivot.y - activeFrame.canvas.h / 2 };
      const O = geometry.Matrix.rotate(thetaDeg);
      const mapPoint = (p: Point2D): Point2D => ({
        x: pivotPose.x + (p.x - pivotPose.x) * O.a + (p.y - pivotPose.y) * O.c,
        y: pivotPose.y + (p.x - pivotPose.x) * O.b + (p.y - pivotPose.y) * O.d,
      });

      // Layer poses: the linear part is a PROPER rotation R(θ), so orientation
      // composes exactly additively (R(θ)·O(rot, flip) = O(rot + θ, flip), the
      // flip fields are untouched). The pose fields are rewritten DIRECTLY —
      // no matrix decomposition, whose whole-degree rounding would lose
      // precision and break the preview==materialization identity.
      const nextById: Record<string, typeof activeFrame.layers.byId[string]> = {};
      activeFrame.layers.order.forEach(id => {
        const l = activeFrame.layers.byId[id];
        const nextP = mapPoint({ x: l.cx, y: l.cy });
        const nextBirthCenter = l.birthCenter
          ? (() => { const bp = mapPoint({ x: l.birthCenter.cx, y: l.birthCenter.cy }); return { cx: bp.x, cy: bp.y }; })()
          : undefined;
        nextById[id] = { ...l, cx: nextP.x, cy: nextP.y, rotation: l.rotation + thetaDeg, birthCenter: nextBirthCenter };
      });

      // The selection rides the pixels through the production arbitrary-angle
      // primitive — it already rotates the rings AND folds the orientation
      // record, so no separate orientation bookkeeping here.
      const nextConfinement = activeFrame.confinement
        ? geometry.polygon.rotatePolygon(activeFrame.confinement, pivot, (thetaDeg * Math.PI) / 180)
        : null;

      // Display-only history accumulator (frame.extra.straightenTotalDeg):
      // sums every materialized θ so the UI can show the total rotation since
      // the original orientation. NO geometry consumer may read it — the
      // poses rewritten above are the only geometric truth. Undo reverts it
      // for free (it rides the same undoable updateFrame).
      const historyDeg = Number(activeFrame.extra?.straightenTotalDeg ?? 0) + thetaDeg;
      actions.updateFrame(activeFrame.id, {
        layers: { byId: nextById, order: activeFrame.layers.order },
        confinement: nextConfinement,
        drafts: remapDrafts(activeFrame.drafts, activeFrame.canvas) ?? activeFrame.drafts,
        extra: { ...activeFrame.extra, straightenTotalDeg: historyDeg },
      });
    }
  } as EditorCommand<{ thetaDeg: number }, void>
};
