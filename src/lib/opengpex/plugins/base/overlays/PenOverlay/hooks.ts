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

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useEditorState, useEditorServices } from '@opengpex/editor/core/context';
import type { Frame } from '@opengpex/editor/core/types';
import { CraftDrawerAPI } from '../../drawers/CraftDrawer/protocols';
import { PenOverlayAPI, PEN_HIT_TOLERANCE_SCREEN_PX } from './protocols';
import { CLIP_PEN_CURSOR } from '@opengpex/editor/icons';
import { deleteDraftAnchor, draftAnchorCount, endActiveSubpath, deleteCommittedAnchor } from './pen/penState';
import { hitTestDraftArea, hitTestDraftSegment, type PenHitOps } from './pen/hitTest';
import { makeLayerPointMapping } from './pen/geometry';
import {
  getPenCommittedSelection,
  getPenDraft,
  getPenDraftSelection,
  findPenLayerBoxAt,
  movePenRubberTip,
  penCommittedAnchorKey,
  penCommittedHandleKey,
  penDraftAnchorKey,
  penDraftHandleKey,
  setPenAnchorHover,
  PEN_DRAFT_SLOT,
  penPhaseFromDraft,
  publishPenPhase,
  setPenCommittedSelection,
  setPenDraftSelection,
  snapshotPenDraft,
} from './interactions';

/**
 * usePenToolLifecycle: cursor feedback + keyboard grammar + session-bound
 * lifecycle for the pen tool.
 *
 * Cursor: `crosshair` while drawing; `move` when hovering an anchor/handle of
 * a committed path (pen-edit will win the press) or anywhere inside a pen
 * layer's visible shape (pen-move will win the press — marker parity). During
 * a drag the owning handler owns the cursor (same guard as the marker
 * lifecycle).
 *
 * Keyboard (mirrors the spec §5.2 operation table):
 * - Enter finishes the receptive subpath (session continues).
 * - Esc ladder: draft-anchor selection → committed-path selection → freeze
 *   the receptive subpath ("exit edit", only when it holds 2+ anchors) →
 *   leave the tool with the draft PRESERVED. Mid-gesture lets the viewport
 *   handler cancel first.
 * - Delete/Backspace deletes the selected anchor — draft anchor (recorded
 *   session step) or committed anchor (undoable command).
 * - Undo/redo are NOT intercepted here: while a scratch session is alive,
 *   `actions.history`'s takeover point serves undo/redo from the session
 *   stack, so the keyboard shortcut and the TimeTraveler button behave
 *   identically with no per-tool key handling.
 *
 * Lifecycle: the pen draft SURVIVES tool deactivation (PS-style work path,
 * 2026-10-24) — the session and its slot stay on the frame, and re-activating
 * the craft resumes the draft via the phase re-publish below. Only Clear
 * Draft (HUD-confirmed) and successful commits end the session. Frame
 * switches suspend/resume the session implicitly; the phase signal is
 * re-published for the newly active frame so the panel reflects the resumed
 * state.
 */
export function usePenToolLifecycle(isPenMode: boolean) {
  const { state, activeFrame } = useEditorState();
  const { actions, geometry } = useEditorServices();
  const frameRef = useRef<Frame | null>(activeFrame);
  useLayoutEffect(() => { frameRef.current = activeFrame; });

  const isInteractingRef = useRef(false);
  useLayoutEffect(() => { isInteractingRef.current = !!state.interaction.isInteracting; });

  const activeFrameId = activeFrame?.id ?? null;

  // ─── Cursor: crosshair base; move over committed anchors (draft idle) ──────
  useEffect(() => {
    if (!isPenMode) {
      // Pen craft deactivated: the draft SURVIVES (PS-style work path —
      // 2026-10-24 change; the session and its slot stay on the frame, and
      // re-activating the tool resumes the draft via the phase re-publish
      // below). Only Clear Draft / commits end the session. Lone anchors
      // are pruned: they carry no committable geometry and kept receptive
      // would hijack the next session's first click.
      pruneLoneAnchors(actions.scratch, frameRef.current?.id ?? '', actions.setStateSignal);
      return;
    }
    // Base cursor = the same crosshair+nib read as the pen selection slot
    // (CLIP_PEN_CURSOR), so the drawing tool and its selection slot share
    // one visual identity; anchor hover still switches to `move` below.
    actions.fast.setCursor(CLIP_PEN_CURSOR);

    // The curve/area hit tests' L0 ops, assembled from the geometry service
    // once per effect run (the service namespaces are stable across renders).
    const hitOps: PenHitOps = { ...geometry.bezier, isPointInPolygon: geometry.polygon.isPointInPolygon };

    // Last known pointer position in viewport px — kept so a Cmd/Ctrl
    // keydown/keyup can re-evaluate the cursor WITHOUT a pointer move
    // (pressing the modifier is a keyboard event; the hover decision depends
    // on it, so the cursor must react in place, not on the next mouse move).
    let lastPos: { vx: number; vy: number } | null = null;

    /** Hover highlight + cursor for one pointer position. Idempotent. */
    const applyHoverAndCursor = (vx: number, vy: number, frame: Frame, metaHeld: boolean) => {
      const cam = actions.fast.latestCamera(frame.id);
      const canvasPt = geometry.space.screenToLocal(vx, vy, frame, cam);

      if (getPenDraft(actions.scratch, frame.id) !== null) {
        // Drawing session: the anchor hover highlight rides a synchronous
        // DOM write (the overlay is pointer-events-none and rebuilt from
        // strings, so CSS :hover cannot fire).
        const draft = getPenDraft(actions.scratch, frame.id)!;
        const tol = PEN_HIT_TOLERANCE_SCREEN_PX / (cam?.k ?? 1);
        const hit = geometry.bezier.nearestPathAnchor({ paths: draft.subpaths }, canvasPt, tol);
        setPenAnchorHover(!hit ? null
          : hit.kind === 'anchor'
            ? penDraftAnchorKey(hit.pathIdx, hit.anchorIdx)
            : penDraftHandleKey(hit.pathIdx, hit.anchorIdx, hit.kind));
        // Over a draggable draft element the cursor announces the drag: a
        // press on an anchor/handle never places a new point, so the pen nib
        // would be a misleading affordance (matches the committed branch).
        // With Cmd/Ctrl held, a SEGMENT or enclosed-AREA hit previews the
        // whole-draft translation instead (the modifier re-routes the press);
        // the curve/area hit-tests only run under the modifier.
        const metaSegment = metaHeld && !hit
          && (hitTestDraftSegment(draft, canvasPt, tol * 2, hitOps) || hitTestDraftArea(draft, canvasPt, hitOps));
        const desired = hit || metaSegment ? 'move' : CLIP_PEN_CURSOR;
        if (actions.fast.getCursor() !== desired) actions.fast.setCursor(desired);
        return;
      }

      // Idle: hover a committed anchor → enlarge it + move cursor (pen-edit
      // wins the press). Inside a pen layer's VISIBLE SHAPE (off-geometry)
      // the move cursor previews pen-move claiming the press (marker parity:
      // no modifier needed — the shape pick doubles as the move affordance).
      // The shape pick is a per-layer world-matrix test, cheap enough to run
      // on plain pointer moves; the curve hit-test stays gated to Cmd since
      // the box pick already covers the geometry's footprint.
      setPenAnchorHover(null);
      let overAnchor = false;
      const ordered = frame.layers.order.map((id) => frame.layers.byId[id]).reverse();
      for (const layer of ordered) {
        if (!layer || layer.type !== 'vector' || !layer.penData || layer.locked || (layer.role && layer.role !== 'host')) continue;
        const mapping = makeLayerPointMapping(geometry.transform.getLayerLocalMatrix(layer, frame));
        const tol = PEN_HIT_TOLERANCE_SCREEN_PX / (cam?.k ?? 1) / mapping.scale;
        const hit = geometry.bezier.nearestPathAnchor(layer.penData, mapping.toLayer(canvasPt), tol);
        if (hit) {
          overAnchor = true;
          setPenAnchorHover(hit.kind === 'anchor'
            ? penCommittedAnchorKey(layer.id, hit.pathIdx, hit.anchorIdx)
            : penCommittedHandleKey(layer.id, hit.pathIdx, hit.anchorIdx, hit.kind));
          break;
        }
      }
      if (!overAnchor) {
        overAnchor = findPenLayerBoxAt(geometry, frame, canvasPt) !== null;
      }
      const desired = overAnchor ? 'move' : CLIP_PEN_CURSOR;
      if (actions.fast.getCursor() !== desired) actions.fast.setCursor(desired);
    };

    const toViewport = (ev: PointerEvent) => {
      const container = document.querySelector('.editor-viewport-container');
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      return { vx: ev.clientX - rect.left, vy: ev.clientY - rect.top };
    };

    const onPointerMove = (ev: PointerEvent) => {
      if (isInteractingRef.current) return;
      const frame = frameRef.current;
      if (!frame) return;
      const pos = toViewport(ev);
      if (!pos) return;
      lastPos = pos;

      // Drawing session: the rubber band tip is written DIRECTLY here (in
      // viewport screen px — the band lives in an unscaled SVG) — a
      // synchronous DOM write inside the pointer event has no clock
      // dependency, so the idle ticker throttling (4fps after 2s without
      // button-held input) can never stall the follow.
      if (getPenDraft(actions.scratch, frame.id) !== null) {
        movePenRubberTip({ x: pos.vx, y: pos.vy });
      }
      applyHoverAndCursor(pos.vx, pos.vy, frame, ev.metaKey || ev.ctrlKey);
    };

    // Cmd/Ctrl press/release re-evaluates the hover + cursor at the last
    // known pointer position — the modifier flips which gesture a press
    // claims (whole-draft translate vs anchor edit), so the affordance must
    // update in place, not on the next mouse move. Typing targets are
    // skipped (same guard as the keyboard grammar below).
    const onModifierKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Meta' && ev.key !== 'Control') return;
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (isInteractingRef.current) return;
      const frame = frameRef.current;
      if (!frame || !lastPos) return;
      applyHoverAndCursor(lastPos.vx, lastPos.vy, frame, ev.metaKey || ev.ctrlKey);
    };

    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('keydown', onModifierKey);
    document.addEventListener('keyup', onModifierKey);
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('keydown', onModifierKey);
      document.removeEventListener('keyup', onModifierKey);
      actions.fast.setCursor(null);
    };
  }, [isPenMode, actions, geometry]);

  // ─── Frame switch: re-publish the phase for the newly active frame ─────────
  // Transitions inside a frame are published by the handlers/commands; only a
  // frame switch bypasses them (the session suspends/resumes untouched).
  useEffect(() => {
    if (!isPenMode || !activeFrameId) return;
    const draft = getPenDraft(actions.scratch, activeFrameId);
    publishPenPhase(actions.setStateSignal, penPhaseFromDraft(draft));
  }, [isPenMode, activeFrameId, actions]);

  // ─── Keyboard grammar ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!isPenMode) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      const frame = frameRef.current;
      if (!frame) return;
      const frameId = frame.id;
      const scratch = actions.scratch;
      const draft = getPenDraft(scratch, frameId);

      // Enter — freeze the receptive subpath; the session continues.
      if (e.key === 'Enter') {
        if (draft) {
          e.preventDefault();
          freezeActiveSubpath(scratch, frameId);
        }
        return;
      }

      // Esc ladder — draft-anchor selection, then committed selection, then
      // "exit edit": freeze the receptive subpath (Enter-equivalent; only
      // when there is something to freeze — a lone anchor is kept as-is,
      // Esc must never destroy), then "exit tool" with the draft PRESERVED
      // (re-activating pen resumes it). Draft discard lives in the panel's
      // Clear Draft button (HUD-confirmed), never on a key.
      // Mid-gesture the viewport cancel wins (skip here).
      if (e.key === 'Escape') {
        if (isInteractingRef.current) return;
        if (getPenDraftSelection()) {
          e.preventDefault();
          e.stopPropagation();
          setPenDraftSelection(null);
          return;
        }
        const committed = getPenCommittedSelection();
        if (committed) {
          e.preventDefault();
          e.stopPropagation();
          setPenCommittedSelection(null);
          return;
        }
        const subs = draft?.subpaths;
        const receptive = subs?.[subs.length - 1];
        if (receptive && !receptive.closed && receptive.anchors.length >= 2) {
          e.preventDefault();
          e.stopPropagation();
          freezeActiveSubpath(scratch, frameId);
          return;
        }
        // Exit rung: prune lone anchors first — a 1-anchor subpath can never
        // be committed and, left receptive, would silently connect the next
        // session's first click to the stale point. Dropping it is lossless.
        pruneLoneAnchors(scratch, frameId, actions.setStateSignal);
        actions.executeCommand(CraftDrawerAPI.commands.deactivate.uid);
        actions.fast.setCursor(null);
        return;
      }

      // Delete / Backspace — remove the selected anchor (draft or committed).
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const draftSel = getPenDraftSelection();
        if (draftSel && draft) {
          e.preventDefault();
          const before = snapshotPenDraft(draft);
          const next = deleteDraftAnchor({ draft, selected: null }, draftSel.pathIdx, draftSel.anchorIdx);
          scratch.set(frameId, PEN_DRAFT_SLOT, keepAliveDraft(next.draft));
          setPenDraftSelection(null);
          scratch.record(frameId, before);
          return;
        }
        const committed = getPenCommittedSelection();
        if (committed && !draft) {
          e.preventDefault();
          const layer = frame.layers.byId[committed.layerId];
          if (layer?.penData) {
            const next = deleteCommittedAnchor(layer.penData, committed);
            actions.executeCommand(PenOverlayAPI.commands.updatePenData.uid, {
              frameId,
              layerId: layer.id,
              penData: next,
            });
            setPenCommittedSelection(null);
          }
        }
        return;
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isPenMode, actions]);

  // Safety net: clear any lingering cursor override on unmount.
  useEffect(() => {
    return () => { actions.fast.setCursor(null); };
  }, [actions]);
}

// ─── Local helpers ─────────────────────────────────────────────────────────────

/**
 * Draft-emptying operations inside a live session must not park null in the
 * slot (the next click would try to begin a second session and throw) — an
 * empty draft keeps the session coherent and renders nothing.
 */
function keepAliveDraft(draft: ReturnType<typeof endActiveSubpath>['draft']) {
  return draft ?? { subpaths: [] };
}

/**
 * Enter-equivalent freeze of the receptive subpath, shared by the Enter key
 * and the Esc ladder's freeze rung. Only a GEOMETRY change is a session
 * step: dropping a dangling anchor or cancelling a lone one is undoable, but
 * the plain freeze (an empty receptive subpath appended as the "next click
 * starts anew" marker) draws nothing, and recording it would cost the user
 * one invisible Cmd+Z. Undoing the last anchor of a frozen subpath simply
 * reopens it.
 */
function freezeActiveSubpath(
  scratch: ReturnType<typeof useEditorServices>['actions']['scratch'],
  frameId: string,
): boolean {
  const draft = getPenDraft(scratch, frameId);
  if (!draft) return false;
  const before = snapshotPenDraft(draft);
  const next = endActiveSubpath({ draft, selected: null });
  scratch.set(frameId, PEN_DRAFT_SLOT, keepAliveDraft(next.draft));
  setPenDraftSelection(null);
  if (draftAnchorCount(next) !== draftAnchorCount({ draft: before, selected: null })) {
    scratch.record(frameId, before);
  }
  return true;
}

/**
 * Drops every 1-anchor subpath from the frame's draft before leaving the
 * tool (and prunes the session entirely when nothing survives): a lone
 * anchor carries no committable geometry, and kept receptive it would
 * connect the next session's first click to the stale point. Subpaths with
 * 2+ anchors stay — a straight polyline is real (drawable/resumable)
 * geometry even though it needs a handle or a third anchor to commit.
 */
function pruneLoneAnchors(
  scratch: ReturnType<typeof useEditorServices>['actions']['scratch'],
  frameId: string,
  setSignal?: Parameters<typeof publishPenPhase>[0],
): void {
  const draft = getPenDraft(scratch, frameId);
  if (!draft) return;
  const kept = draft.subpaths.filter((s) => s.anchors.length >= 2 || s.closed);
  if (kept.length === draft.subpaths.length) return;
  if (kept.length === 0) {
    scratch.set(frameId, PEN_DRAFT_SLOT, null);
    scratch.end(frameId);
    if (setSignal) publishPenPhase(setSignal, 'idle');
    return;
  }
  scratch.set(frameId, PEN_DRAFT_SLOT, { subpaths: kept });
}
