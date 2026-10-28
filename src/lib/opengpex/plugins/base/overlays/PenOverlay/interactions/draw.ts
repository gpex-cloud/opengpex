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
 * PenDrawHandler (priority 145) — place anchors into the draft session.
 *
 * Every press that survives arbitration (pen-rotate/resize/move/edit all
 * claim their targets at higher priorities) lands here: the first press of
 * a session seeds a fresh draft, subsequent presses extend the receptive
 * subpath, a press (click or drag) on the first anchor closes it — the drag
 * pulls the closing seam's smooth handles —, a press on a frozen subpath's
 * end resumes it, a press on an existing draft anchor either toggles
 * smooth/corner (Alt), moves it (drag) or — as a plain click — deletes it /
 * retracts the just-placed anchor's out-handle, a press on a draft SEGMENT
 * de Casteljau-inserts an anchor exactly on the curve and picks it up, and
 * a Cmd/Ctrl press anywhere on a subpath (anchor, handle, curve or enclosed
 * area) translates that one subpath.
 *
 * One gesture = one undo step: the gesture mutates a private working copy;
 * at gesture end an EXPLICIT has-change comparison (U1, GIMP's undo_motion
 * — the caller declares the step's existence) decides whether the working
 * copy is persisted through the undoable draft command. An unchanged
 * gesture (select-only click) writes nothing; cancelling mid-gesture rolls
 * the working copy back and writes nothing (U2: untraceable by
 * construction).
 */

import type { InteractionEvent, InteractionHandler, Point2D } from '@opengpex/editor/core/types';
import type { PenDraft, PenSelection } from '../pen/penState';
import {
  closeActiveSubpath,
  deleteDraftAnchor,
  dragCloseSeamHandles,
  dragDraftAnchorPart,
  dragNewHandles,
  hitFrozenSubpathEnd,
  insertDraftSegmentAnchor,
  placeAnchor,
  resumeFrozenSubpath,
  retractDraftOutHandle,
  settleNewHandles,
  startDraft,
  toggleDraftAnchorSmooth,
} from '../pen/penState';
import { findDraftSegmentHit, findDraftSubpathAt, type PenHitOps } from '../pen/hitTest';
import {
  beginPenGesture,
  canvasTolerance,
  composePenToolState,
  commitPenToolState,
  discardPenWork,
  endPenGesture,
  getPenDraft,
  passesBaseGate,
  publishPenPhase,
  setPenDraftSelection,
  snapshotPenDraft,
} from './shared';

type DrawMode =
  | 'idle'
  | 'pull-handles'      // dragging out the fresh anchor's symmetric handles
  | 'drag-draft-anchor' // dragging an existing draft anchor
  | 'drag-draft-handle' // dragging an existing draft anchor's control handle
  | 'drag-subpath'      // Cmd/Ctrl+drag anywhere on a subpath: translating that subpath
  | 'drag-close-seam'   // dragging from the start anchor right after closing: seam handles
  | null;

type DragTarget = { pathIdx: number; anchorIdx: number; kind: PenSelection['kind'] };

/**
 * What a PLAIN press on a draft anchor does when it ends WITHOUT a drag
 * (Photoshop's pen-over-anchor reads): 'delete' removes the anchor (Pen -),
 * 'retract' collapses the just-placed anchor's outgoing handle so the next
 * segment leaves straight. A drag turns the same press into an anchor move
 * instead.
 */
type ClickAction = 'delete' | 'retract' | null;

export const createPenDrawHandler = (): InteractionHandler => {
  let mode: DrawMode = null;
  let dragTarget: DragTarget | null = null;
  let clickAction: ClickAction = null;
  let before: ReturnType<typeof snapshotPenDraft> = null;
  // Whether a drag-draft-anchor gesture actually moved the anchor: a plain
  // click on an anchor resolves its click action instead, and must not
  // persist a step whose payload equals the live draft (an invisible undo).
  let anchorMoved = false;
  // Subpath translation: which subpath the Cmd press took hold of, the press
  // point (the move delta derives from it against the PRE-gesture snapshot,
  // so every move is drift-free) and whether the gesture actually moved
  // anything (a press-and-release must not persist an invisible step).
  let moveSubpathIdx = -1;
  let startPt = { x: 0, y: 0 };
  let draftMoved = false;

  /** The subpath a Cmd press lands on: element → segment → enclosed ring. */
  const subpathUnderPress = (e: InteractionEvent, draft: PenDraft, hitOps: PenHitOps): number | null => {
    const tol = canvasTolerance(e);
    const pt = e.point.canvas;
    const element = e.geometry.bezier.nearestPathAnchor({ paths: draft.subpaths }, pt, tol);
    if (element) return element.pathIdx;
    return findDraftSubpathAt(draft, pt, tol * 2, hitOps);
  };

  return {
    id: 'pen-draw',
    priority: 145,
    // Both modifier channels carry pen semantics inside this handler, so it
    // must stay consultable while the dispatcher filters on an engaged
    // spring channel: 'meta' routes the Cmd/Ctrl subpath translate here
    // (without it the draft becomes undraggable), 'alt' keeps every
    // Alt-held press (Alt+click smooth⇄corner toggle, Alt-held handle
    // press, Alt+click on the just-placed anchor) from being swallowed by
    // the global layer-move fallback.
    springOverride: ['meta', 'alt'],

    test: (e) => {
      const draft = getPenDraft(e.activeFrame);
      // Outside the pen tool the draft is a visible outline (PS Work Path
      // read), and the spring philosophy is "Cmd = move what is under the
      // pointer" — so a Cmd press landing on draft geometry claims the
      // subpath translate in ANY mode. Plain presses fall through: other
      // tools own them and the outline is read-only there.
      if (!passesBaseGate(e)) {
        if (!e.keys.meta || !draft) return false;
        const target = e.nativeEvent.target as HTMLElement;
        if (target.closest('button, a, input, [data-role="ui"], [data-handle], [data-gizmo-handle], [data-gizmo-rotate]')) return false;
        const frame = e.activeFrame;
        if (!e.geometry.space.isPointInRect(e.point.canvas, { x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h })) return false;
        const hitOps: PenHitOps = { ...e.geometry.bezier, isPointInPolygon: e.geometry.polygon.isPointInPolygon };
        return subpathUnderPress(e, draft, hitOps) !== null;
      }
      // Cmd/Ctrl is the transform modifier: during a session it translates
      // the SUBPATH under the pointer (anchor, handle, curve or enclosed
      // area — routed in onStart). On committed layers Cmd belongs to
      // pen-move (162, which yields while a session is alive). A meta press
      // with NO session must never start drawing — a missed Cmd+drag would
      // drop a stray anchor on release.
      if (e.keys.meta) {
        if (!draft) return false;
        // Only a press that actually lands on a subpath claims the gesture;
        // a miss returns false so the press falls through to layer-move —
        // other layers stay Cmd-draggable while a draft is alive. Because
        // the claim itself requires the hit, no anchor can be placed by a
        // missed Cmd+drag (only this handler places anchors).
        const hitOps: PenHitOps = { ...e.geometry.bezier, isPointInPolygon: e.geometry.polygon.isPointInPolygon };
        return subpathUnderPress(e, draft, hitOps) !== null;
      }
      return true;
    },

    onStart: (e) => {
      const tol = canvasTolerance(e);
      const pt = e.point.canvas;
      const frame = e.activeFrame;
      const hitOps: PenHitOps = { ...e.geometry.bezier, isPointInPolygon: e.geometry.polygon.isPointInPolygon };

      // Working copy: a fresh mutable clone of the persisted payload (null
      // seeds nothing — the startDraft call below opens the session). No
      // store writes happen here; the persistence point is gesture end.
      let st = beginPenGesture(frame);

      // First anchor of a session: seed an empty draft. A persisted draft
      // normally continues its session. (A draft that survived a commit —
      // Apply as Mask keeps it as a PS-style work path — also continues:
      // the first press extends it rather than replacing it.)
      if (!st.draft) {
        commitPenToolState(startDraft(st));
        publishPenPhase(e.actions.setStateSignal, 'drawing');
        st = composePenToolState(frame);
      }

      before = snapshotPenDraft(st.draft);
      anchorMoved = false;
      draftMoved = false;
      clickAction = null;
      startPt = { x: pt.x, y: pt.y };

      // Cmd/Ctrl + press anywhere on a subpath (anchor, handle, curve or
      // enclosed area — open polylines count their implicitly closed area)
      // translates THAT subpath (one gesture = one step). Only the
      // component under the pointer moves: several closed rings in one
      // session are independent shapes/holes and must not travel together.
      // Plain presses still place/edit — the modifier marks the transform
      // intent. With Cmd held, closing/resuming/placing are all off the
      // table. test() already guaranteed the hit; this re-derivation only
      // names the subpath.
      if (e.keys.meta) {
        moveSubpathIdx = subpathUnderPress(e, st.draft!, hitOps) ?? -1;
        mode = moveSubpathIdx >= 0 ? 'drag-subpath' : 'idle';
        return;
      }

      // Press on the receptive subpath's first anchor (≥3 anchors) closes
      // it. A plain click closes sharp (as before); DRAGGING from the start
      // anchor continues in 'drag-close-seam' and pulls the closing seam's
      // handles symmetrically (Photoshop's smooth close: hover the start
      // anchor and drag). Alt mid-drag turns only the incoming side.
      const last = st.draft!.subpaths[st.draft!.subpaths.length - 1];
      if (last && !last.closed && last.anchors.length >= 3) {
        const first = last.anchors[0];
        if (Math.hypot(first.x - pt.x, first.y - pt.y) <= tol) {
          commitPenToolState(closeActiveSubpath(st));
          mode = 'drag-close-seam';
          return;
        }
      }

      // Click on a FROZEN subpath's end anchor resumes it (Photoshop's
      // "continue the path" read): it becomes receptive again, so the next
      // placement extends it and its first anchor closes it. The resume is
      // pure bookkeeping (no visible change) — never a persisted step — and
      // the press stays a drag-draft-anchor gesture so the endpoint can
      // still be moved by dragging instead of just resuming. It also
      // consumes a pending freeze intent (continuing the subpath IS its
      // unfreeze). No anchor selection is set: resuming is a "keep drawing"
      // intent, and a selection here would make the Esc ladder spend its
      // first rung on clearing a selection the user never asked for.
      const frozenIdx = hitFrozenSubpathEnd(st, pt, tol);
      if (frozenIdx >= 0) {
        commitPenToolState(resumeFrozenSubpath(st, frozenIdx));
        const resumed = composePenToolState(frame);
        const pi = resumed.draft!.subpaths.length - 1;
        const ai = resumed.draft!.subpaths[pi].anchors.length - 1;
        setPenDraftSelection(null);
        dragTarget = { pathIdx: pi, anchorIdx: ai, kind: 'anchor' };
        before = snapshotPenDraft(resumed.draft);
        mode = 'drag-draft-anchor';
        return;
      }

      // Press on an existing draft anchor or its control handles: handles win
      // over anchors when both are in range (smaller target, shared hit test).
      // A press on a handle endpoint picks the handle up for a drag (Alt
      // breaks the opposite handle's symmetry mid-drag). On an ANCHOR the
      // just-placed one (receptive tail's end) is special: Alt+click AND a
      // plain click both retract only its outgoing handle, so the previous
      // segment keeps its curvature and the next leaves straight. Any other
      // anchor: Alt+press toggles smooth/corner (one persisted step); a plain
      // press picks it up for a move — and if it ends without moving, the
      // plain CLICK deletes it (the hover cursor announced `-` beforehand).
      const hit = e.geometry.bezier.nearestPathAnchor({ paths: st.draft!.subpaths }, pt, tol);
      if (hit) {
        const sub = st.draft!.subpaths[hit.pathIdx];
        const isJustPlaced = hit.kind === 'anchor'
          && hit.pathIdx === st.draft!.subpaths.length - 1
          && !sub.closed && !st.frozen && hit.anchorIdx === sub.anchors.length - 1;
        if (hit.kind === 'anchor' && e.keys.alt) {
          const next = isJustPlaced
            ? retractDraftOutHandle(st, hit.pathIdx, hit.anchorIdx)
            : toggleDraftAnchorSmooth(st, hit.pathIdx, hit.anchorIdx);
          commitPenToolState({ ...next, selected: null });
          setPenDraftSelection(null);
          mode = 'idle';
        } else {
          setPenDraftSelection({ pathIdx: hit.pathIdx, anchorIdx: hit.anchorIdx });
          dragTarget = { pathIdx: hit.pathIdx, anchorIdx: hit.anchorIdx, kind: hit.kind };
          mode = hit.kind === 'anchor' ? 'drag-draft-anchor' : 'drag-draft-handle';
          if (hit.kind === 'anchor') clickAction = isJustPlaced ? 'retract' : 'delete';
        }
        return;
      }

      // Press on a draft SEGMENT (Photoshop's Pen +): de Casteljau-insert a
      // smooth anchor exactly on the curve — the shape stays bit-for-bit —
      // and pick the new anchor up for a move, so a plain click just adds
      // the point while a press+drag shapes it in the same gesture. The
      // segment tolerance doubles the anchor tolerance (lower-value target;
      // the anchor scan above already ran first). Without this branch a
      // click meant to add a point would append a stray end anchor instead.
      const segHit = findDraftSegmentHit(st.draft!, pt, tol * 2, hitOps);
      if (segHit) {
        const inserted = insertDraftSegmentAnchor(st, segHit.pathIdx, segHit.segIdx, segHit.t);
        if (inserted) {
          commitPenToolState(inserted.state);
          setPenDraftSelection({ pathIdx: segHit.pathIdx, anchorIdx: inserted.anchorIdx });
          dragTarget = { pathIdx: segHit.pathIdx, anchorIdx: inserted.anchorIdx, kind: 'anchor' };
          anchorMoved = true; // the insertion is already a real change
          mode = 'drag-draft-anchor';
          return;
        }
      }

      // Fresh anchor; the drag (if any) pulls out its symmetric handles.
      commitPenToolState(placeAnchor(st, pt));
      dragTarget = null;
      mode = 'pull-handles';
    },

    onMove: (e) => {
      if (!mode) return;
      const pt = e.point.canvas;
      const frame = e.activeFrame;
      const st = composePenToolState(frame);
      if (mode === 'pull-handles') {
        commitPenToolState(dragNewHandles(st, pt, e.keys.alt));
      } else if (mode === 'drag-draft-anchor' && dragTarget) {
        // A pending click action (delete/retract) needs a dead zone of two
        // screen pixels before the press turns into a move: pointer jitter
        // between press and release must not silently convert a click into
        // an anchor nudge and swallow the announced action.
        if (!anchorMoved && clickAction
          && Math.hypot(pt.x - startPt.x, pt.y - startPt.y) < canvasTolerance(e) / 4) return;
        anchorMoved = true;
        commitPenToolState(dragDraftAnchorPart(st, dragTarget.pathIdx, dragTarget.anchorIdx, 'anchor', pt, false));
      } else if (mode === 'drag-draft-handle' && dragTarget) {
        anchorMoved = true;
        commitPenToolState(
          dragDraftAnchorPart(st, dragTarget.pathIdx, dragTarget.anchorIdx, dragTarget.kind, pt, e.keys.alt),
        );
      } else if (mode === 'drag-close-seam') {
        // Closing-seam handles: drag from the start anchor right after close
        // pulls the seam's symmetric handle pair (Alt turns the incoming
        // side only). A click-without-drag never reaches here and stays sharp.
        commitPenToolState(dragCloseSeamHandles(st, pt, e.keys.alt));
      } else if (mode === 'drag-subpath' && before) {
        // The translated subpath derives from the PRE-gesture snapshot and
        // the TOTAL pointer delta — never from the previous move's output —
        // so a long gesture accumulates no drift. Every other subpath is
        // carried over from the snapshot untouched; the session's freeze
        // intent survives (moving a shape is not drawing).
        const dx = pt.x - startPt.x;
        const dy = pt.y - startPt.y;
        if (dx !== 0 || dy !== 0) draftMoved = true;
        const map = (p: Point2D): Point2D => ({ x: p.x + dx, y: p.y + dy });
        const source = before.subpaths[moveSubpathIdx];
        if (!source) return;
        const translated = e.geometry.bezier.mapPathAnchors({ paths: [source] }, map).paths[0];
        const subpaths = before.subpaths.map((s, i) => (i === moveSubpathIdx ? translated : s));
        commitPenToolState({ draft: { subpaths }, selected: null, frozen: st.frozen });
      }
    },

    onEnd: (e) => {
      const frame = e.activeFrame;
      if (mode === 'pull-handles') {
        // A click without a real drag leaves a sharp anchor: collapse the
        // residual handle offsets below 1px. A real drag keeps its handles
        // exactly as the last move left them (Alt asymmetry included).
        commitPenToolState(settleNewHandles(composePenToolState(frame)));
      } else if (mode === 'drag-draft-anchor' && !anchorMoved && clickAction && dragTarget) {
        // The press never moved: it is a plain CLICK on the anchor, resolved
        // now as the pen-over-anchor action the hover cursor announced.
        const st = composePenToolState(frame);
        if (clickAction === 'delete') {
          const next = deleteDraftAnchor(st, dragTarget.pathIdx, dragTarget.anchorIdx);
          commitPenToolState({ ...next, selected: null });
          setPenDraftSelection(null);
          if (!next.draft) publishPenPhase(e.actions.setStateSignal, 'idle');
          anchorMoved = true;
        } else {
          const next = retractDraftOutHandle(st, dragTarget.pathIdx, dragTarget.anchorIdx);
          if (next !== st) {
            commitPenToolState(next);
            anchorMoved = true;
          }
        }
      }
      // One gesture = one undo step (placed anchor / handle pull / anchor
      // move / handle move / close / smooth toggle / whole-draft translate /
      // click-delete / click-retract). A select-only click changes nothing
      // and persists nothing (U1: the caller declares the step's existence;
      // U2's zero-write applies to the unchanged case the same way it
      // applies to cancellation).
      const activityChanged = mode === 'drag-subpath' ? draftMoved : mode !== 'drag-draft-anchor' || anchorMoved;
      endPenGesture(e.actions, frame, before, activityChanged);
      mode = null;
      dragTarget = null;
      clickAction = null;
      moveSubpathIdx = -1;
      before = null;
      anchorMoved = false;
      draftMoved = false;
    },

    onCancel: () => {
      // U2: the gesture never touched the persisted payload — dropping the
      // working copy is the whole cancellation. No store operations at all.
      discardPenWork();
      mode = null;
      dragTarget = null;
      clickAction = null;
      moveSubpathIdx = -1;
      before = null;
      anchorMoved = false;
      draftMoved = false;
    },
  };
};
