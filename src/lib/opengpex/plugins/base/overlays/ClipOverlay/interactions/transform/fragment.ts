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
 * SelectionSessionTransformHandler (priority 125) — free transform of the
 * PEELED state, driven THROUGH THE SELECTION's gizmo (clip mode only; pan
 * sessions offer no transform affordance — Space switches to clip). The
 * peel session hangs on the frame; this handler owns the session branch of
 * selection-driven transforms (finding 13): the user grabs the SELECTION's
 * handles, the fragment follows affinely. Lives one tier above the plain
 * selection transform (120), which yields entirely while a session is
 * undecided (its test refuses session frames).
 *
 * Geometry: every factor is solved on the SELECTION's own rotated box (the
 * entity that always carries the TRUE orientation — the fragment's pose
 * loses it at every bake), through the shared pure solve in
 * `core/geometry/operators/polygon.ts` (`solveGizmoResizeScale`):
 *   - Corner drags: diagonal anchor (opposite corner of the rotated box),
 *     per-axis factors along the selection's ROTATED axes, Shift = uniform,
 *     dragging past the anchor mirrors (negative factor).
 *   - Rotation dot: spins about the content center, Shift snaps the
 *     ABSOLUTE orientation to 15°.
 * The fragment receives the same map through the `sourceAngle`
 * pose slot (world linear part `O(θ)·S·R(−θ)`), so the preview override
 * and the bake composite ride identical slots — baked pixels ≡ preview.
 *
 * Commit model ("松手即烘焙"): the gesture streams pose through the
 * volatile channels only — cx/cy/rotation via the buffered layer patch,
 * scale via the `fragmentTransform` transient (no Layer field; `Layer.scale`
 * stays deprecated). At pointer-up the pose is handed to
 * `cmd.peel.apply_transform`, which bakes it into a NEW asset (write-
 * copy) in ONE undoable step; this transaction then aborts WITHOUT landing,
 * so no second undo step exists. Esc before the bake = abort → the fragment
 * returns to its peeled pose.
 *
 * Settle interleave: a settle(commit) arriving mid-gesture (Space/Enter with
 * the pointer down) consumes the in-flight pose through the command-layer
 * registration (see peel.ts) and bakes BEFORE promoting, in the same call
 * stack. This handler then finds the gesture consumed at pointer-up and
 * skips its own bake.
 */

import type { InteractionHandler, InteractionEvent, TransformParams } from '@opengpex/editor/core/types';
import { InteractionTransaction } from '@opengpex/editor/stage/interaction/Transaction';
import { readPeelSession, fragmentTrueRotationDeg } from '../../peel/session';
import {
  registerInflightFragmentTransform,
  clearInflightFragmentTransform,
  isInflightFragmentTransformConsumed,
} from '../../peel/inflight';
import * as P from '../../protocols';
import type { FragmentPose, FragmentScaleHandle, LocalPolygon, InteractionEvent as GestureEvent } from '@opengpex/editor/core/types';
import { ClipOptionsAPI } from '../../../../options/ClipOptions/protocols';

type FragmentTransformMode = FragmentScaleHandle | 'rotate';

/** Below this drag distance (canvas px) the gesture is a static click — no bake. */
const MOVE_THRESHOLD_PX = 2;

export const createSessionTransformHandler = (): InteractionHandler => {
  let mode: FragmentTransformMode | null = null;
  let startParams: FragmentPose | null = null;
  let startCanvas = { x: 0, y: 0 };
  let startPointerAngleRad = 0;
  let exchangeId: string | null = null;
  let sourceAssetId: string | undefined;
  let startConfinement: LocalPolygon | null = null;
  /**
   * The fragment's TRUE on-screen orientation (degrees) at gesture start —
   * the base the Shift snap grid anchors on. It has two parts:
   *   - the orientation the BAKED PIXELS carry (each bake moves the layer's
   *     field rotation into pixels and zeroes the field, so it is invisible
   *     to `layer.rotation`; reconstructed as origin rotation + accRotation
   *     whenever the exchange no longer sits on its source asset), and
   *   - the live field rotation still un-baked on the layer.
   * Snapping against the zeroed field alone would strand off-grid
   * accumulated angles — a rotated fragment could never return to upright.
   * Only the snap GRID uses this; the gesture's output rotation stays in
   * layer-field space.
   */
  let rotationSnapBaseDeg = 0;
  // ─── Selection-basis scale state (selection-driven, finding 13) ──────────
  // Scale factors are solved on the SELECTION's own rotated box — the
  // entity that always carries the TRUE orientation (the fragment's pose
  // loses it at every bake, which zeroes the field rotation into pixels;
  // solving on that stale pose sheared the rotated content into a
  // parallelogram). The fragment receives the SAME map through the
  // `sourceAngle` pose slot: world linear part =
  // `O(θ) · diag(sx, sy) · R(−θ)`, expressible end-to-end (preview
  // override AND bake composite ride the identical slots, so baked pixels
  // ≡ preview pixels by construction).
  let scaleThetaRad = 0;
  let scaleBoxCx = 0;
  let scaleBoxCy = 0;
  let scaleBoxW = 0;
  let scaleBoxH = 0;
  let scaleAnchorX = 0;
  let scaleAnchorY = 0;
  // The fragment's CONTENT center at gesture start (world) — the point the
  // map carries forward when converting back to the pose's bounding anchor
  // (cx, cy), which the visibleOffset compensation hangs off.
  let scaleStartContentCx = 0;
  let scaleStartContentCy = 0;
  let tx: InteractionTransaction | null = null;
  // The pose this gesture will commit — updated on every move, read by the
  // settle interleave via the in-flight registration and by pointer-up.
  let pose: TransformParams = {};

  const reset = () => {
    mode = null;
    startParams = null;
    exchangeId = null;
    sourceAssetId = undefined;
    startConfinement = null;
    rotationSnapBaseDeg = 0;
    scaleThetaRad = 0;
    scaleBoxCx = 0;
    scaleBoxCy = 0;
    scaleBoxW = 0;
    scaleBoxH = 0;
    scaleAnchorX = 0;
    scaleAnchorY = 0;
    scaleStartContentCx = 0;
    scaleStartContentCy = 0;
    tx = null;
    pose = {};
  };

  // The selection is glued to its peeled fragment: every live pose update
  // carries the gesture-start selection by the same map the fragment's
  // content box took. The bake command writes the final value in the same
  // undo step, so this live write only ever rides the volatile frame draft.
  const followSelection = (e: GestureEvent, next: TransformParams) => {
    if (!tx || !startParams || !startConfinement) return;
    const end: FragmentPose = {
      ...startParams,
      cx: next.cx ?? startParams.cx,
      cy: next.cy ?? startParams.cy,
      rotation: next.rotation ?? startParams.rotation,
      scale: next.scale ?? 1,
      scaleY: next.scaleY ?? next.scale ?? 1,
    };
    const confinement = e.geometry.transform.followFragmentSelection(startConfinement, startParams, end, e.activeFrame);
    tx.update({ confinement }, 'frame');
  };

  return {
    id: 'clip-session-transform',
    priority: 125,
    // The handles are specific DOM targets — claiming Shift/Alt here only
    // means "transform handles keep working while a modifier is held"
    // (Shift rotate-snap and uniform-scale read the key mid-gesture). Same
    // declaration as the selection transform handler.
    springOverride: ['shift', 'alt'],

    test: (e: InteractionEvent): boolean => {
      const interactionMode = e.state.interaction.interactionMode;
      // Mode-agnostic: the peel session hangs on the frame (Phase 1), so the
      // transform works in clip AND pan. Re-Canvas keeps its exclusive modal.
      if (!(interactionMode === 'clip' || interactionMode === 'pan')) return false;
      if (e.state.getStateSignal(ClipOptionsAPI.signals.reCanvas)) return false;

      const frame = e.activeFrame;
      const session = readPeelSession(frame);
      if (!session || session.status !== 'peeled') return false;
      const exchange = frame.layers.byId[session.exchangeId];
      if (!exchange || exchange.type !== 'image' || exchange.locked) return false;

      // The press must land on the CLIP SELECTION's gizmo (scoped by
      // data-clip-selection-gizmo on the overlay's gizmo containers) — a
      // marker/text gizmo press with an unrelated session in flight must
      // never hijack into a fragment transform.
      const target = e.nativeEvent.target as HTMLElement;
      if (!target.closest('[data-clip-selection-gizmo]')) {
        return false;
      }
      const gizmoEl = target.closest('[data-gizmo-handle], [data-gizmo-rotate]') as HTMLElement | null;
      if (!gizmoEl) {
        return false;
      }

      if (gizmoEl.dataset.gizmoRotate) {
        mode = 'rotate';
      } else {
        const handle = gizmoEl.dataset.gizmoHandle || '';
        if (!['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'].includes(handle)) return false;
        mode = handle as FragmentScaleHandle;
      }
      exchangeId = exchange.id;
      return true;
    },

    onStart: (e) => {
      const frame = e.activeFrame;
      const session = readPeelSession(frame);
      const exchange = session && session.status === 'peeled'
        ? frame.layers.byId[session.exchangeId]
        : undefined;
      if (!session || !exchange || exchange.type !== 'image') {
        reset();
        return;
      }

      startParams = e.geometry.transform.fragmentPoseFromLayer(exchange);
      sourceAssetId = exchange.assetId;
      startConfinement = frame.confinement ?? null;
      startCanvas = { x: e.point.canvas.x, y: e.point.canvas.y };
      pose = {};
      exchangeId = exchange.id;

      if (mode === 'rotate') {
        // Rotation pivot = the content center at gesture start; the pointer
        // angle is measured against it so the box never jumps under a
        // stationary press (the delta is 0 on the first move).
        const pivot = e.geometry.transform.fragmentContentCenter(startParams);
        startPointerAngleRad = Math.atan2(e.point.world.y - pivot.y, e.point.world.x - pivot.x);
        // Shift snap grid anchors on the TRUE on-screen orientation (see the
        // field comment). One shared probe with the HUD/DeltaLabel so all
        // three can never disagree.
        rotationSnapBaseDeg = fragmentTrueRotationDeg(session, exchange);
      } else if (startConfinement) {
        // Scale gesture: measure the SELECTION's own rotated box through
        // THE shared gizmo basis (the plain selection transform measures
        // identically). The orientation probe is the fragment's TRUE
        // rotation (the same source the snap grid and the HUD anchor use):
        // the session selection's rings are rotated by the affine follow,
        // but its `orientationDeg` RECORD is not maintained there — reading
        // the record would solve every post-rotation gesture at 0° and
        // shear the content.
        scaleThetaRad = (fragmentTrueRotationDeg(session, exchange) * Math.PI) / 180;
        const basis = e.geometry.polygon.measureGizmoResizeAnchor(startConfinement, scaleThetaRad, mode as 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w');
        scaleBoxCx = basis.cx;
        scaleBoxCy = basis.cy;
        scaleBoxW = Math.max(basis.w, 1);
        scaleBoxH = Math.max(basis.h, 1);
        // World-space anchor — the fixed point of the whole map. Note the
        // basis is CANVAS-local while the fragment content center below is
        // WORLD: convert with the sign-correct offset before use.
        scaleAnchorX = basis.anchorX;
        scaleAnchorY = basis.anchorY;
        // The fragment's content center at gesture start: the point the map
        // carries to the new (cx, cy).
        const c0 = e.geometry.transform.fragmentContentCenter(startParams);
        scaleStartContentCx = c0.x;
        scaleStartContentCy = c0.y;
      }

      tx = new InteractionTransaction(e);
      // Silent: the bake command owns the undo boundary; this transaction is
      // a volatile-only live channel and always terminates in abort().
      tx.begin(true);

      // Finding 14: the SELECTION displays the angle — the chip rides the
      // frame channel and reads the confinement's first-ring orientation,
      // which follows the fragment affinely (true orientation, bake-proof).
      if (mode === 'rotate') {
        tx.declareFeedback({ kind: 'rotate', target: 'frame', origin: { x: exchange.cx, y: exchange.cy } });
      }

      registerInflightFragmentTransform({
        frameId: frame.id,
        exchangeId: exchange.id,
        getPose: () => pose,
      });

      // Gesture cursor: keep whatever pose-resolved cursor the pressed handle
      // declared (the gizmo's hover channel freezes during drags).
      const target = e.nativeEvent.target as HTMLElement;
      const cursor = target.closest('[data-gizmo-cursor]')?.getAttribute('data-gizmo-cursor');
      if (cursor) e.actions.fast.cursor.notifyDragging(cursor);
    },

    onMove: (e) => {
      if (!tx || !tx.isActive || !startParams || !mode || !exchangeId) return;

      if (mode === 'rotate') {
        const next = e.geometry.transform.computeFragmentRotation(
          startParams,
          e.point.world,
          startParams.rotation,
          startPointerAngleRad,
          { shift: e.keys.shift, absoluteBaseDeg: rotationSnapBaseDeg },
        );
        pose = { cx: next.cx, cy: next.cy, rotation: next.rotation };
        // Rotation streams entirely through the regular layer patch; the
        // scale transient carries nothing on this branch.
        tx.update({ cx: next.cx, cy: next.cy, rotation: next.rotation }, 'layer', exchangeId);
        e.actions.fast.setTransient('fragmentTransform', null);
        followSelection(e, next);
        return;
      }

      // Scale gesture — solve on the SELECTION's local frame (see the state
      // field comment), then route the SAME map to both coupled entities:
      // the selection through the polygon composite, the fragment through
      // the local-frame pose slots + transient.
      const cos = Math.cos(scaleThetaRad);
      const sin = Math.sin(scaleThetaRad);
      const pdx = e.point.canvas.x - scaleBoxCx;
      const pdy = e.point.canvas.y - scaleBoxCy;
      const { sx, sy } = e.geometry.polygon.solveGizmoResizeScale(
        mode as 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w',
        pdx * cos + pdy * sin,
        -pdx * sin + pdy * cos,
        scaleBoxW,
        scaleBoxH,
        { uniform: e.keys.shift, minW: 1, minH: 1 },
      );

      // The local-frame map M = R(θ)·diag(sx, sy)·R(−θ), as matrix entries.
      const m00 = sx * cos * cos + sy * sin * sin;
      const m01 = (sx - sy) * cos * sin;
      const m11 = sx * sin * sin + sy * cos * cos;
      const applyM = (vx: number, vy: number): { x: number; y: number } => ({
        x: m00 * vx + m01 * vy,
        y: m01 * vx + m11 * vy,
      });

      // New content center = anchor + M·(start center − anchor); the pose's
      // bounding anchor (cx, cy) compensates the visible offset under M.
      // ORIGIN DISCIPLINE: the selection box / anchor live in CANVAS-local
      // coords (top-left origin) while the fragment content center and pose
      // anchor live in WORLD coords (canvas-centre origin): world = canvas
      // − half canvas. M is linear — origin-independent — but the FIXED
      // POINT is not: convert the anchor with the RIGHT sign before
      // re-anchoring the fragment, or the fragment re-anchors around the
      // point MIRRORED across the canvas centre and drifts with the drag
      // (the bake stays self-consistent, so it snaps back on release).
      const worldAnchorX = scaleAnchorX - e.activeFrame.canvas.w / 2;
      const worldAnchorY = scaleAnchorY - e.activeFrame.canvas.h / 2;
      const dcx = scaleStartContentCx - worldAnchorX;
      const dcy = scaleStartContentCy - worldAnchorY;
      const contentCx = worldAnchorX + applyM(dcx, dcy).x;
      const contentCy = worldAnchorY + applyM(dcx, dcy).y;
      const off = applyM(startParams.visibleOffset.x, startParams.visibleOffset.y);
      const thetaDeg = (scaleThetaRad * 180) / Math.PI;

      pose = {
        cx: contentCx - off.x,
        cy: contentCy - off.y,
        rotation: thetaDeg,
        scale: sx,
        scaleY: sy,
        sourceAngle: thetaDeg,
      };
      tx.update({ cx: pose.cx, cy: pose.cy }, 'layer', exchangeId);
      // The selection follows by the very same local-frame map.
      if (startConfinement) {
        const confinement = e.geometry.polygon.scalePolygon(
          startConfinement,
          { x: scaleAnchorX, y: scaleAnchorY },
          sx,
          sy,
          scaleThetaRad,
        );
        tx.update({ confinement }, 'frame');
      }
      e.actions.fast.setTransient('fragmentTransform', {
        layerId: exchangeId,
        sourceAssetId,
        scaleX: sx,
        scaleY: sy,
        rotationDeg: thetaDeg,
        sourceAngle: thetaDeg,
      });
    },

    onEnd: async (e) => {
      const moved =
        Math.abs(e.point.canvas.x - startCanvas.x) > MOVE_THRESHOLD_PX ||
        Math.abs(e.point.canvas.y - startCanvas.y) > MOVE_THRESHOLD_PX;
      const finalPose = pose;
      const wasConsumed = isInflightFragmentTransformConsumed();
      const id = exchangeId;
      const liveTx = tx;
      clearInflightFragmentTransform();
      e.actions.fast.cursor.notifyDragging(null);
      reset();

      // 松手即烘焙 — unless a settle already consumed and baked this
      // gesture's pose mid-drag (settle interleave), or the press never
      // moved. ORDER MATTERS: the live preview (buffered pose + scale
      // transient) must stay on screen for the whole async bake. The bake
      // command hands over to the baked asset flash-free and only returns
      // once the committed state shows it; tearing the preview down first
      // would show the pre-gesture pose for the entire bake window.
      // Cleanup MUST reach in BOTH branches: if the bake command ever
      // rejects (resource exhaustion, driver failure), the gesture-scoped
      // teardown (preview transient + silent transaction abort) must still
      // run — the finally owns that guarantee.
      try {
        if (!wasConsumed && moved && id) {
          await e.actions.executeCommand(P.CMD_PEEL_APPLY_TRANSFORM, { pose: finalPose });
        }
      } finally {
        e.actions.fast.setTransient('fragmentTransform', null);
        // Silent transaction: abort drops the volatile channel without
        // landing it (the bake command owns the undo step).
        liveTx?.abort();
      }
    },

    onCancel: (e) => {
      clearInflightFragmentTransform();
      e.actions.fast.setTransient('fragmentTransform', null);
      e.actions.fast.cursor.notifyDragging(null);
      if (tx) {
        tx.abort();
        tx = null;
      }
      reset();
    },
  };
};
