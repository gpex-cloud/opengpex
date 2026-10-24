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
 * claim their targets at higher priorities) lands here: the first press of a
 * session opens the scratch slot, subsequent presses extend the receptive
 * subpath, a press on the first anchor closes it, a press on a frozen
 * subpath's end resumes it, and a press on an existing draft anchor either
 * toggles smooth/corner (Alt) or picks the anchor up for a move.
 *
 * One gesture = one undo step, recorded as a PRE-gesture snapshot via
 * `scratch.record` (the session history takeover serves undo/redo from it).
 */

import type { InteractionHandler, Point2D } from '@opengpex/editor/core/types';
import type { PenDraft, PenSelection } from '../pen/penState';
import {
  closeActiveSubpath,
  dragDraftAnchorPart,
  dragNewHandles,
  hitFrozenSubpathEnd,
  placeAnchor,
  resumeFrozenSubpath,
  settleNewHandles,
  startDraft,
  toggleDraftAnchorSmooth,
} from '../pen/penState';
import { hitTestDraftArea, hitTestDraftSegment, type PenHitOps } from '../pen/hitTest';
import {
  canvasTolerance,
  composePenToolState,
  commitPenToolState,
  getPenDraft,
  PEN_DRAFT_SLOT,
  PEN_SESSION_OWNER,
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
  | 'drag-whole-draft'  // Cmd/Ctrl+drag on a segment: translating the whole draft
  | null;

type DragTarget = { pathIdx: number; anchorIdx: number; kind: PenSelection['kind'] };

export const createPenDrawHandler = (): InteractionHandler => {
  let mode: DrawMode = null;
  let dragTarget: DragTarget | null = null;
  let before: PenDraft | null = null;
  // Whether a drag-draft-anchor gesture actually moved the anchor: a plain
  // click on an anchor only selects it (tool state) and must not record a
  // session step whose snapshot equals the live draft (an invisible undo).
  let anchorMoved = false;
  // Whole-draft translation: the press point (the move delta derives from it
  // against the PRE-gesture snapshot, so every move is drift-free) and
  // whether the gesture actually moved anything (a select-only click must
  // not record an invisible session step).
  let startPt = { x: 0, y: 0 };
  let draftMoved = false;

  return {
    id: 'pen-draw',
    priority: 145,

    test: (e) => {
      if (!passesBaseGate(e)) return false;
      // Cmd/Ctrl is the transform modifier: on committed layers it belongs
      // to pen-move (162, which yields while a session is alive); during a
      // session it is the whole-draft translation modifier (routed in
      // onStart). A meta press with NO session must never start drawing — a
      // missed Cmd+drag would drop a stray anchor on release. With a session
      // alive the press is admitted here and onStart consumes it (translate
      // or no-op).
      if (e.keys.meta && getPenDraft(e.actions.scratch, e.activeFrame.id) === null) return false;
      return true;
    },

    onStart: (e) => {
      const tol = canvasTolerance(e);
      const pt = e.point.canvas;
      const scratch = e.actions.scratch;
      const frameId = e.activeFrame.id;

      let st = composePenToolState(scratch, frameId);

      // First anchor of a session: open the scratch session and seed the
      // slot. An existing slot draft normally continues its session — a
      // second begin would throw. The exception is a draft that survived a
      // commit (Apply as Mask keeps the draft as a PS-style work path while
      // ending its session): it has geometry but no live session, so one is
      // re-opened over the kept slot without re-seeding.
      if (!st.draft) {
        scratch.begin(frameId, PEN_SESSION_OWNER, PEN_DRAFT_SLOT);
        commitPenToolState(startDraft(st), scratch, frameId);
        publishPenPhase(e.actions.setStateSignal, 'drawing');
        st = composePenToolState(scratch, frameId);
      } else if (!scratch.activeSession(frameId)) {
        scratch.begin(frameId, PEN_SESSION_OWNER, PEN_DRAFT_SLOT);
        publishPenPhase(e.actions.setStateSignal, 'drawing');
      }

      before = snapshotPenDraft(st.draft);
      anchorMoved = false;
      draftMoved = false;

      // Cmd/Ctrl + press on a draft SEGMENT or anywhere inside its ENCLOSED
      // AREA translates the WHOLE draft (all subpaths, one gesture = one
      // session step). Open polylines are tested against their implicitly
      // closed area, so "inside" works whether the path is closed or not.
      // Plain presses still place anchors — the modifier marks the transform
      // intent. The route runs FIRST: with Cmd held, closing/resuming/placing
      // are all off the table. A meta press that misses the draft entirely is
      // consumed as a no-op so a missed Cmd+drag cannot drop a stray anchor.
      if (e.keys.meta) {
        const hitOps: PenHitOps = { ...e.geometry.bezier, isPointInPolygon: e.geometry.polygon.isPointInPolygon };
        startPt = { x: pt.x, y: pt.y };
        const onDraft = hitTestDraftSegment(st.draft!, pt, tol * 2, hitOps)
          || hitTestDraftArea(st.draft!, pt, hitOps);
        mode = onDraft ? 'drag-whole-draft' : 'idle';
        return;
      }

      // Click on the receptive subpath's first anchor (≥3 anchors) closes it.
      const last = st.draft!.subpaths[st.draft!.subpaths.length - 1];
      if (last && !last.closed && last.anchors.length >= 3) {
        const first = last.anchors[0];
        if (Math.hypot(first.x - pt.x, first.y - pt.y) <= tol) {
          const closed = closeActiveSubpath(st);
          commitPenToolState(closed, scratch, frameId);
          const count = closed.draft?.subpaths.filter((s) => s.closed).length ?? 0;
          e.actions.notifyHUD(`Path closed (${count} closed subpath${count > 1 ? 's' : ''})`, 'info');
          mode = 'idle';
          return;
        }
      }

      // Click on a FROZEN subpath's end anchor resumes it (Photoshop's
      // "continue the path" read): it becomes receptive again, so the next
      // placement extends it and its first anchor closes it. The resume is
      // pure bookkeeping (no visible change) — not a recorded step — and the
      // press stays a drag-draft-anchor gesture so the endpoint can still be
      // moved by dragging instead of just resuming.
      const frozenIdx = hitFrozenSubpathEnd(st, pt, tol);
      if (frozenIdx >= 0) {
        commitPenToolState(resumeFrozenSubpath(st, frozenIdx), scratch, frameId);
        const resumed = composePenToolState(scratch, frameId);
        const pi = resumed.draft!.subpaths.length - 1;
        const ai = resumed.draft!.subpaths[pi].anchors.length - 1;
        setPenDraftSelection({ pathIdx: pi, anchorIdx: ai });
        dragTarget = { pathIdx: pi, anchorIdx: ai, kind: 'anchor' };
        before = snapshotPenDraft(resumed.draft);
        mode = 'drag-draft-anchor';
        return;
      }

      // Click on an existing draft anchor or its control handles: handles win
      // over anchors when both are in range (smaller target, shared hit test).
      // Alt+click on the ANCHOR toggles smooth/corner (one recorded step); a
      // plain click on the anchor selects + picks it up for a move; a press
      // on a handle endpoint picks the handle up for a drag (Alt breaks the
      // opposite handle's symmetry mid-drag).
      const hit = e.geometry.bezier.nearestPathAnchor({ paths: st.draft!.subpaths }, pt, tol);
      if (hit) {
        if (hit.kind === 'anchor' && e.keys.alt) {
          const toggled = toggleDraftAnchorSmooth(st, hit.pathIdx, hit.anchorIdx);
          commitPenToolState({ ...toggled, selected: null }, scratch, frameId);
          setPenDraftSelection(null);
          mode = 'idle';
        } else {
          setPenDraftSelection({ pathIdx: hit.pathIdx, anchorIdx: hit.anchorIdx });
          dragTarget = { pathIdx: hit.pathIdx, anchorIdx: hit.anchorIdx, kind: hit.kind };
          mode = hit.kind === 'anchor' ? 'drag-draft-anchor' : 'drag-draft-handle';
        }
        return;
      }

      // Fresh anchor; the drag (if any) pulls out its symmetric handles.
      commitPenToolState(placeAnchor(st, pt), scratch, frameId);
      dragTarget = null;
      mode = 'pull-handles';
    },

    onMove: (e) => {
      if (!mode) return;
      const pt = e.point.canvas;
      const scratch = e.actions.scratch;
      const frameId = e.activeFrame.id;
      const st = composePenToolState(scratch, frameId);
      if (mode === 'pull-handles') {
        commitPenToolState(dragNewHandles(st, pt, e.keys.alt), scratch, frameId);
      } else if (mode === 'drag-draft-anchor' && dragTarget) {
        anchorMoved = true;
        commitPenToolState(dragDraftAnchorPart(st, dragTarget.pathIdx, dragTarget.anchorIdx, 'anchor', pt, false), scratch, frameId);
      } else if (mode === 'drag-draft-handle' && dragTarget) {
        anchorMoved = true;
        commitPenToolState(
          dragDraftAnchorPart(st, dragTarget.pathIdx, dragTarget.anchorIdx, dragTarget.kind, pt, e.keys.alt),
          scratch,
          frameId,
        );
      } else if (mode === 'drag-whole-draft' && before) {
        // The translated draft derives from the PRE-gesture snapshot and the
        // TOTAL pointer delta — never from the previous move's output — so a
        // long gesture accumulates no drift.
        const dx = pt.x - startPt.x;
        const dy = pt.y - startPt.y;
        if (dx !== 0 || dy !== 0) draftMoved = true;
        const map = (p: Point2D): Point2D => ({ x: p.x + dx, y: p.y + dy });
        const translated = e.geometry.bezier.mapPathAnchors({ paths: before.subpaths }, map).paths;
        commitPenToolState({ draft: { subpaths: translated }, selected: null }, scratch, frameId);
      }
    },

    onEnd: (e) => {
      const scratch = e.actions.scratch;
      const frameId = e.activeFrame.id;
      if (mode === 'pull-handles') {
        // A click without a real drag leaves a sharp anchor: collapse the
        // residual handle offsets below 1px. A real drag keeps its handles
        // exactly as the last move left them (Alt asymmetry included).
        commitPenToolState(settleNewHandles(composePenToolState(scratch, frameId)), scratch, frameId);
      }
      // One gesture = one undo step (placed anchor / handle pull / anchor
      // move / handle move / close / smooth toggle / whole-draft translate).
      // A select-only click changes nothing in the slot and records nothing.
      const changed = mode === 'drag-whole-draft' ? draftMoved : mode !== 'drag-draft-anchor' || anchorMoved;
      if (before && changed) {
        scratch.record(frameId, before);
      }
      mode = null;
      dragTarget = null;
      before = null;
      anchorMoved = false;
      draftMoved = false;
    },

    onCancel: (e) => {
      if (before) {
        // Roll the draft back to the pre-gesture snapshot (session stays).
        e.actions.scratch.set(e.activeFrame.id, PEN_DRAFT_SLOT, before);
      }
      mode = null;
      dragTarget = null;
      before = null;
      anchorMoved = false;
      draftMoved = false;
    },
  };
};
