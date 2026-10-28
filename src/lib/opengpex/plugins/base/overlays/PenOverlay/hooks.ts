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
import { deleteDraftAnchor, deleteCommittedAnchor, endActiveSubpath } from './pen/penState';
import { findDraftSubpathAt, hitTestDraftSegment, type PenHitOps } from './pen/hitTest';
import { resolveDraftHoverIntent } from './pen/hoverIntent';
import { PEN_CURSOR_ADD_POINT, PEN_CURSOR_BASE, PEN_CURSOR_NEW_PATH, PEN_INTENT_CURSORS } from './pen/cursors';
import { makeLayerPointMapping } from './pen/geometry';
import { canvasToScreen, getPenRubberTip } from './pen/render';
import {
  beginPenGesture,
  clearPenFreezeIntent,
  commitPenToolState,
  composePenToolState,
  discardPenWork,
  endPenGesture,
  findSegmentHitAt,
  getPenCommittedSelection,
  getPenDraft,
  getPenDraftSelection,
  isOwnDraftWrite,
  settlePenFreezeIntent,
  movePenRubberTip,
  penCommittedAnchorKey,
  penCommittedHandleKey,
  penDraftAnchorKey,
  penDraftHandleKey,
  penDraftEquals,
  penPhaseFromDraft,
  persistPenDraft,
  placePenRubberTip,
  publishPenPhase,
  setPenAnchorHover,
  setPenCommittedSelection,
  setPenDraftSelection,
  snapshotPenDraft,
} from './interactions';

/**
 * usePenToolLifecycle: cursor feedback + keyboard grammar + lifecycle for
 * the pen tool.
 *
 * Cursor: the pen nib carries a badge announcing what the next plain press
 * does (see pen/cursors.ts): nothing = continue the open subpath, `*` = new
 * subpath, `o` = close, `/` = resume a frozen end, `+` = insert on segment,
 * `-` = delete anchor, `^` = Alt convert / retract the just-placed anchor's
 * out-handle, hollow arrow = drag a handle. The decision is the pure
 * `resolveDraftHoverIntent`, shared with the draw handler's press routing so
 * the badge can never promise something the press will not do. Committed
 * geometry (no session): `move` over anchors/handles (pen-edit drags them),
 * `+` over a committed segment, `*` elsewhere. Cmd/Ctrl held: the cursor
 * service's spring rule shows `move`. During a drag the owning handler owns
 * the cursor (same guard as the marker lifecycle).
 *
 * Keyboard (mirrors the pen operation grammar):
 * - Enter freezes the receptive subpath. A PURE freeze (2+ anchors) is zero
 *   write — only the session's freeze intent moves, so undoing afterwards
 *   hits the last real anchor placement, never an invisible step. Dropping a
 *   lone dangling anchor is a real geometry change and persists undoably.
 * - Esc ladder: draft-anchor selection → committed-path selection → freeze
 *   (Enter-equivalent) → leave the tool with the draft PRESERVED (PS-style
 *   work path). While the rubber band is live, deselect and freeze collapse
 *   into one press. Mid-gesture lets the viewport handler cancel first.
 * - Delete/Backspace deletes the selected anchor — draft anchor (undoable
 *   draft write) or committed anchor (undoable command).
 * - Undo/redo need no interception here: the draft IS document state on
 *   `frame.drafts.pen`, so the plain per-frame history serves undo/redo and
 *   the resync pass below re-aligns session memory with the restored frame.
 *
 * Resync (single-point rule): whenever the active frame object is replaced
 * by something OTHER than this tool's own write (undo/redo, frame switch,
 * another tool's commit), session memory that references draft geometry by
 * index must be invalidated or it goes stale: the freeze intent clears, the
 * draft-anchor selection is validated against the restored payload (and
 * dropped when its target is gone — a stale selection would delete the
 * wrong anchor), and the phase signal re-publishes. The tool's own writes
 * are recognized by payload reference and pass through untouched.
 */
export function usePenToolLifecycle(isPenMode: boolean) {
  const { state, activeFrame } = useEditorState();
  const { actions, geometry } = useEditorServices();
  const frameRef = useRef<Frame | null>(activeFrame);
  useLayoutEffect(() => { frameRef.current = activeFrame; });

  const isInteractingRef = useRef(false);
  useLayoutEffect(() => { isInteractingRef.current = !!state.interaction.isInteracting; });

  // ─── Resync: external frame identity changes invalidate session memory ─────
  // Where the draft came from decides whether its open tail is receptive:
  // a draft that MATERIALIZED (appeared from null, arrived with a frame
  // switch, or was already there when the tool was entered) starts frozen;
  // a draft that merely changed while drawing (undo of one anchor) stays
  // receptive. The three "materialized" signals are tracked here as the
  // previous run's facts.
  const hadDraftRef = useRef(false);
  const wasPenModeRef = useRef(false);
  const lastFrameIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeFrame) return;
    const draft = getPenDraft(activeFrame);
    const hadDraft = hadDraftRef.current;
    const wasPenMode = wasPenModeRef.current;
    const frameSwitched = lastFrameIdRef.current !== activeFrame.id;
    hadDraftRef.current = draft !== null;
    wasPenModeRef.current = isPenMode;
    lastFrameIdRef.current = activeFrame.id;
    const contextChanged = frameSwitched || (isPenMode && !wasPenMode);
    // The tool's own write: memory stays coherent (the payload it just wrote
    // is exactly what the frame now holds). The shortcut only applies while
    // the session context is unchanged — after a frame switch or a tool
    // re-entry the payload identity may still match (nothing else touched
    // the draft) yet the receptiveness and phase below must be re-derived.
    if (!contextChanged && isOwnDraftWrite(activeFrame)) return;
    // A draft that appeared from null here is an EXTERNAL materialization
    // (undo of a commit, another tool's write) — the tool's own first-anchor
    // write never reaches this line.
    const materialized = draft !== null && (!hadDraft || contextChanged);
    settlePenFreezeIntent(draft, materialized);
    const sel = getPenDraftSelection();
    if (sel && (!draft
      || !draft.subpaths[sel.pathIdx]
      || !draft.subpaths[sel.pathIdx].anchors[sel.anchorIdx])) {
      setPenDraftSelection(null);
    }
    if (isPenMode) {
      publishPenPhase(actions.setStateSignal, penPhaseFromDraft(draft));
    }
  }, [activeFrame, isPenMode, actions]);

  // ─── Cursor: crosshair base; move over committed anchors (draft idle) ──────
  useEffect(() => {
    if (!isPenMode) {
      // Pen craft deactivated: the draft SURVIVES (PS-style work path — it
      // lives on the frame and re-activating the tool resumes it via the
      // phase re-publish below). Only Clear Draft / commits end the session.
      // Lone anchors are pruned: they carry no committable geometry and kept
      // receptive would hijack the next session's first click.
      pruneLoneAnchors(actions, frameRef.current);
      clearPenFreezeIntent();
      discardPenWork();
      return;
    }
    // Base cursor = crosshair + nib (the same read as the pen selection
    // slot); the hover rule below swaps in the badged variants (*, o, /, +,
    // -, ^, direct-select arrow) that announce what the next press will do.
    actions.fast.cursor.register('pen', PEN_CURSOR_BASE);

    // The curve/area hit tests' L0 ops, assembled from the geometry service
    // once per effect run (the service namespaces are stable across renders).
    const hitOps: PenHitOps = { ...geometry.bezier, isPointInPolygon: geometry.polygon.isPointInPolygon };

    // Last known pointer position in viewport px — kept so a Cmd/Ctrl/Alt
    // keydown/keyup can re-evaluate the cursor WITHOUT a pointer move
    // (pressing the modifier is a keyboard event; the hover decision depends
    // on it, so the cursor must react in place, not on the next mouse move).
    let lastPos: { vx: number; vy: number } | null = null;

    /** Hover highlight + cursor for one pointer position. Idempotent. */
    const applyHoverAndCursor = (vx: number, vy: number, frame: Frame, metaHeld: boolean, altHeld: boolean) => {
      const cam = actions.fast.latestCamera(frame.id);
      const canvasPt = geometry.space.screenToLocal(vx, vy, frame, cam);
      const tol = PEN_HIT_TOLERANCE_SCREEN_PX / (cam?.k ?? 1);

      const draft = getPenDraft(frame);
      if (draft !== null) {
        // Drawing session: the anchor hover highlight rides a synchronous
        // DOM write (the overlay is pointer-events-none and rebuilt from
        // strings, so CSS :hover cannot fire).
        const hit = geometry.bezier.nearestPathAnchor({ paths: draft.subpaths }, canvasPt, tol);
        setPenAnchorHover(!hit ? null
          : hit.kind === 'anchor'
            ? penDraftAnchorKey(hit.pathIdx, hit.anchorIdx)
            : penDraftHandleKey(hit.pathIdx, hit.anchorIdx, hit.kind));
        // Cmd/Ctrl held: the press translates the subpath under the pointer
        // — the cursor service's spring rule already shows `move` while the
        // key is down; the hover declaration keeps element-level consumers
        // in agreement about the target (same pick as the press).
        if (metaHeld) {
          const metaTarget = !!hit || findDraftSubpathAt(draft, canvasPt, tol * 2, hitOps) !== null;
          actions.fast.cursor.notifyHover(metaTarget ? 'move' : null);
          return;
        }
        // Plain / Alt hover: the same rung order the draw handler's press
        // uses decides the badge (close, resume, convert, handle, delete,
        // insert, continue, new path).
        const segmentHit = !hit && hitTestDraftSegment(draft, canvasPt, tol * 2, hitOps);
        const intent = resolveDraftHoverIntent(composePenToolState(frame), canvasPt, tol, hit, segmentHit, altHeld);
        actions.fast.cursor.notifyHover(PEN_INTENT_CURSORS[intent]);
        return;
      }

      // Idle (no session): hover a committed anchor/handle → enlarge it +
      // move cursor (pen-edit wins the press and drags it); a committed
      // SEGMENT previews the insert (pen-edit splits it on press); anything
      // else is the "new path" read — the next press opens a session.
      // Off-geometry hover never shows a move affordance: moving a layer
      // requires the spring key.
      setPenAnchorHover(null);
      let overAnchor = false;
      const ordered = frame.layers.order.map((id) => frame.layers.byId[id]).reverse();
      for (const layer of ordered) {
        if (!layer || layer.type !== 'vector' || !layer.penData || layer.locked || (layer.role && layer.role !== 'host')) continue;
        const mapping = makeLayerPointMapping(geometry.transform.getLayerLocalMatrix(layer, frame));
        const layerTol = tol / mapping.scale;
        const hit = geometry.bezier.nearestPathAnchor(layer.penData, mapping.toLayer(canvasPt), layerTol);
        if (hit) {
          overAnchor = true;
          setPenAnchorHover(hit.kind === 'anchor'
            ? penCommittedAnchorKey(layer.id, hit.pathIdx, hit.anchorIdx)
            : penCommittedHandleKey(layer.id, hit.pathIdx, hit.anchorIdx, hit.kind));
          break;
        }
      }
      if (overAnchor) {
        actions.fast.cursor.notifyHover('move');
        return;
      }
      const overSegment = !metaHeld && findSegmentHitAt(geometry, frame, canvasPt, cam?.k ?? 1) !== null;
      actions.fast.cursor.notifyHover(overSegment ? PEN_CURSOR_ADD_POINT : metaHeld ? null : PEN_CURSOR_NEW_PATH);
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

      // Drawing session: the rubber band is driven ENTIRELY from here, in
      // viewport screen px (the band lives in an unscaled SVG). Its start
      // point is re-derived from the live state on every move — the same
      // receptiveness read the cursor uses — so a zero-write transition
      // (resume, freeze) shows or hides the band immediately without
      // waiting for a ticker pass that an idle session may never get; its
      // tip follows the pointer with a synchronous DOM write that has no
      // clock dependency (the idle ticker throttles to 4fps after 2s without
      // button-held input, which would stall any ticker-driven follow).
      if (getPenDraft(frame) !== null) {
        const tip = getPenRubberTip(composePenToolState(frame));
        if (tip) {
          placePenRubberTip(canvasToScreen(tip, actions.fast.latestCamera(frame.id)));
          movePenRubberTip({ x: pos.vx, y: pos.vy });
        } else {
          placePenRubberTip(null);
        }
      }
      applyHoverAndCursor(pos.vx, pos.vy, frame, ev.metaKey || ev.ctrlKey, ev.altKey);
    };

    // Cmd/Ctrl/Alt press/release re-evaluates the hover + cursor at the last
    // known pointer position — the modifier flips which gesture a press
    // claims (transform vs edit, convert vs delete), so the affordance must
    // update in place, not on the next mouse move. Typing targets are
    // skipped (same guard as the keyboard grammar below).
    const onModifierKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Meta' && ev.key !== 'Control' && ev.key !== 'Alt') return;
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (isInteractingRef.current) return;
      const frame = frameRef.current;
      if (!frame || !lastPos) return;
      applyHoverAndCursor(lastPos.vx, lastPos.vy, frame, ev.metaKey || ev.ctrlKey, ev.altKey);
    };

    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('keydown', onModifierKey);
    document.addEventListener('keyup', onModifierKey);
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('keydown', onModifierKey);
      document.removeEventListener('keyup', onModifierKey);
      actions.fast.cursor.register('pen', null);
      actions.fast.cursor.notifyHover(null);
    };
  }, [isPenMode, actions, geometry]);

  // ─── Keyboard grammar ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!isPenMode) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      const frame = frameRef.current;
      if (!frame) return;
      const draft = getPenDraft(frame);

      // Enter — freeze the receptive subpath; the session continues.
      if (e.key === 'Enter') {
        if (draft) {
          e.preventDefault();
          freezeActiveSubpath(actions, frame);
        }
        return;
      }

      // Esc ladder — draft-anchor selection, then committed selection, then
      // "exit edit": freeze the receptive subpath (Enter-equivalent; a lone
      // anchor is dropped instead — it carries no geometry), then "exit tool"
      // with the draft PRESERVED
      // (re-activating pen resumes it). Draft discard lives in the panel's
      // Clear Draft button (undoable), never on a key.
      // Mid-gesture the viewport cancel wins (skip here).
      if (e.key === 'Escape') {
        if (isInteractingRef.current) return;
        // Freeze rung while the receptive subpath still takes anchors (the
        // rubber band is showing). A lone anchor takes the same rung: it
        // carries no geometry, so Esc drops it (endActiveSubpath's rule) and
        // stays in the tool — exiting is the NEXT Esc. Once the freeze
        // intent is pending there is nothing left to freeze: the
        // marker-subpath era made the next Esc fall through to exit
        // naturally (the appended empty subpath failed the ≥2 check), and
        // the intent flag must play that role now — without this guard Esc
        // would re-freeze forever and never reach the exit rung.
        const subs = draft?.subpaths;
        const receptive = subs?.[subs.length - 1];
        const frozenPending = composePenToolState(frame).frozen;
        const canFreeze = !!receptive && !receptive.closed && receptive.anchors.length >= 1 && !frozenPending;
        if (getPenDraftSelection()) {
          e.preventDefault();
          e.stopPropagation();
          setPenDraftSelection(null);
          // A selection is a by-product of dragging an anchor while drawing;
          // when the rubber band is still live the user's Esc means "stop
          // this line", so the deselect and the freeze happen in ONE press
          // (the freeze below clears the selection itself). Only with no
          // live line does Esc stop at the deselect.
          if (!canFreeze) return;
        }
        const committed = getPenCommittedSelection();
        if (committed) {
          e.preventDefault();
          e.stopPropagation();
          setPenCommittedSelection(null);
          return;
        }
        if (canFreeze) {
          e.preventDefault();
          e.stopPropagation();
          freezeActiveSubpath(actions, frame);
          return;
        }
        // Exit rung: prune lone anchors first — a 1-anchor subpath can never
        // be committed and, left receptive, would silently connect the next
        // session's first click to the stale point. Dropping it is lossless.
        pruneLoneAnchors(actions, frame);
        actions.executeCommand(CraftDrawerAPI.commands.deactivate.uid);
        actions.fast.cursor.notifyHover(null);
        return;
      }

      // Delete / Backspace — remove the selected anchor (draft or committed).
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const draftSel = getPenDraftSelection();
        if (draftSel && draft) {
          e.preventDefault();
          const st = beginPenGesture(frame);
          const before = snapshotPenDraft(st.draft);
          const next = deleteDraftAnchor({ draft: st.draft, selected: null, frozen: st.frozen }, draftSel.pathIdx, draftSel.anchorIdx);
          setPenDraftSelection(null);
          commitPenToolState({ ...next, selected: null });
          endPenGesture(actions, frame, before, true);
          if (!next.draft) publishPenPhase(actions.setStateSignal, 'idle');
          return;
        }
        const committed = getPenCommittedSelection();
        if (committed && !draft) {
          e.preventDefault();
          const layer = frame.layers.byId[committed.layerId];
          if (layer?.penData) {
            const next = deleteCommittedAnchor(layer.penData, committed);
            actions.executeCommand(PenOverlayAPI.commands.updatePenData.uid, {
              frameId: frame.id,
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

  // Safety net: drop this tool's cursor registration on unmount.
  useEffect(() => {
    return () => {
      actions.fast.cursor.register('pen', null);
      actions.fast.cursor.notifyHover(null);
    };
  }, [actions]);
}

// ─── Local helpers ─────────────────────────────────────────────────────────────

/**
 * Enter-equivalent freeze of the receptive subpath, shared by the Enter key
 * and the Esc ladder's freeze rung. Only a GEOMETRY change persists: the
 * pure freeze (an intent flag move that draws nothing) is zero write, so it
 * never costs the user one invisible Cmd+Z — undoing after a pure freeze
 * removes the last real anchor. Dropping a dangling anchor (the lone-anchor
 * rung inside endActiveSubpath) IS a geometry change and persists undoably.
 */
function freezeActiveSubpath(
  actions: ReturnType<typeof useEditorServices>['actions'],
  frame: Frame,
): boolean {
  const st = beginPenGesture(frame);
  if (!st.draft) return false;
  const before = snapshotPenDraft(st.draft);
  const next = endActiveSubpath(st);
  commitPenToolState(next);
  setPenDraftSelection(null);
  const changed = !penDraftEquals(before, next.draft);
  endPenGesture(actions, frame, before, changed);
  if (!next.draft) publishPenPhase(actions.setStateSignal, 'idle');
  return true;
}

/**
 * Drops every 1-anchor subpath from the frame's draft before leaving the
 * tool (and clears the draft entirely when nothing survives): a lone anchor
 * carries no committable geometry, and kept receptive it would connect the
 * next session's first click to the stale point. Subpaths with 2+ anchors
 * stay — a straight polyline is real (drawable/resumable) geometry even
 * though it needs a handle or a third anchor to commit. The prune is a real
 * geometry change when it fires, so it persists as an undoable step.
 */
function pruneLoneAnchors(
  actions: ReturnType<typeof useEditorServices>['actions'],
  frame: Frame | null,
): void {
  if (!frame) return;
  const draft = getPenDraft(frame);
  if (!draft) return;
  const kept = draft.subpaths.filter((s) => s.anchors.length >= 2 || s.closed);
  if (kept.length === draft.subpaths.length) return;
  persistPenDraft(actions, frame.id, kept.length > 0 ? { subpaths: kept } : null);
  if (kept.length === 0) publishPenPhase(actions.setStateSignal, 'idle');
}
