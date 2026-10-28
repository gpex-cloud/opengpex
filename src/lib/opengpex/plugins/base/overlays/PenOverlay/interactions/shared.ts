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
 * shared.ts — Pen tool state and services shared by the interaction handlers.
 *
 * The pen tool state is split by ownership:
 *
 * - The DRAFT (in-progress path) is DOCUMENT state: it lives on
 *   `frame.drafts.pen` through the core drafts channel (typed codec,
 *   frozen reads, replace-style writes) and its changes flow through the
 *   same per-frame undo ledger as every other edit — one gesture = one
 *   history step, committed with `cmd.pen_set_draft` when the gesture ends
 *   with an actual change (a select-only click never writes). During a
 *   gesture the handler mutates a PRIVATE module-level working copy (the
 *   clone taken at gesture start); the persisted payload is only replaced
 *   at gesture end, so pointer-frequency edits never touch Redux.
 * - Tool-session memory (the committed-path selection, the draft-anchor
 *   selection, the freeze intent) stays in this module store: it is
 *   ephemeral UI state that must not enter the document. Any external
 *   change to `frame.drafts.pen` (undo/redo, frame switch, another tool's
 *   commit) invalidates it via the lifecycle's resync pass.
 * - The rubber band and the anchor-hover highlight are direct DOM writes
 *   into the overlay's SVG (bound once by component refs) — the overlay is
 *   pointer-events-none and rebuilt from strings, so CSS :hover cannot fire
 *   and ticker-driven updates stall at the idle 4fps; synchronous writes in
 *   the pointer event have neither problem.
 *
 * Handler routes (priority-based arbitration): a press that lands on
 * committed path geometry is taken by pen-edit; anything else falls through
 * to the draft. During a draft session pen-edit yields (its test requires
 * the draft to be null), so every click continues the session.
 */

import {
  type EditorActions,
  type Frame,
  type InteractionEvent,
  type InteractionSignalValue,
  type Layer,
} from '@opengpex/editor/core/types';
import { cloneFrameDraft, readFrameDraft } from '@opengpex/editor/core/state/drafts';
import { ADV_FRAME_SET_DRAFT } from '@opengpex/editor/core/advanced/protocols';
import { CraftDrawerAPI } from '../../../drawers/CraftDrawer/protocols';
import * as P from '../protocols';
import type { PenDraft, PenDraftSelection, PenPhase, PenSelection } from '../pen/penState';
import type { PenToolState } from '../pen/penState';
import { makeLayerPointMapping, screenToleranceToLayer } from '../pen/geometry';

export const ACTIVE_CRAFT_KEY = CraftDrawerAPI.signals.activeCraft;

/** The key this tool owns inside `Frame.drafts` (matches the codec's toolId). */
export const PEN_TOOL_ID = 'pen';

export type SignalWriter = (key: string, value: InteractionSignalValue) => void;

// ─── Tool-side store (module-level, cross-React-boundary) ──────────────────────

let _selected: PenSelection | null = null;
let _draftSelected: PenDraftSelection | null = null;
/** Bumped on selection-only changes so the overlay repaint dirty-check sees them. */
let _selectionVersion = 0;

// ─── Draft working copy (R1b: the only mutable alias, one per gesture) ──────────

/** The gesture's private draft; null whenever no gesture is in flight. */
let _work: PenDraft | null = null;
/** Bumped on every working-copy write so the overlay dirty-check sees gestures. */
let _workVersion = 0;
/**
 * The write this tool last performed: the owning frame's id plus the exact
 * payload object that landed in `frame.drafts.pen`. The lifecycle's resync
 * pass compares both (by reference, for the id; by identity, for the
 * payload — safe because the per-frame history's structural sharing keeps
 * untouched payload references stable, the same invariant the undo patch
 * machinery relies on): match ⇒ the frame change was this tool's own write
 * (keep session memory), mismatch ⇒ an external change (undo/redo, frame
 * switch, another tool) — session memory must be invalidated.
 */
let _lastWrite: { frameId: string; payload: object } | null = null;

/** True when `frame.drafts.pen` still holds the payload this tool wrote. */
export function isOwnDraftWrite(frame: Frame | null | undefined): boolean {
  if (!_lastWrite || !frame || frame.id !== _lastWrite.frameId) return false;
  return frame.drafts?.[PEN_TOOL_ID] === _lastWrite.payload;
}

/**
 * Reads the live draft: the gesture working copy while a gesture is in
 * flight, otherwise the frame's persisted payload as a frozen deep copy
 * (the drafts-channel memoized read — callers never receive the stored
 * reference, so nothing can mutate history state in place).
 */
export function getPenDraft(frame: Frame | null | undefined): PenDraft | null {
  if (_work) return _work;
  return readFrameDraft<PenDraft>(frame, PEN_TOOL_ID);
}

/** Assembles the pure state machine's view: live draft + module memory. */
export function composePenToolState(frame: Frame | null | undefined): PenToolState {
  return { draft: getPenDraft(frame), selected: _selected, frozen: _frozen };
}

// Backing flag for the freeze intent: Enter/Esc set it, the next placement
// consumes it, and the lifecycle's resync pass clears it on any external
// draft change. It deliberately survives the between-gestures window (where
// the working copy is already discarded) so "Enter, then click" opens a new
// subpath wherever that click lands.
let _frozen = false;

/**
 * Gesture start: takes a fresh MUTABLE clone of the persisted payload (the
 * R1b working copy) and returns the composed state machine view. Handlers
 * mutate through the pure state machine and write back with
 * {@link commitPenToolState}; nothing here touches the store.
 */
export function beginPenGesture(frame: Frame | null | undefined): PenToolState {
  const persisted = frame ? cloneFrameDraft<PenDraft>(frame, PEN_TOOL_ID) : null;
  _work = persisted;
  _workVersion++;
  return composePenToolState(frame);
}

/**
 * Gesture-internal write: parks the state machine's draft half in the
 * working copy and the selection/freeze halves in the module store. Pure
 * module write — no store dispatch (pointer frequency).
 */
export function commitPenToolState(next: PenToolState): void {
  _work = next.draft;
  _selected = next.selected;
  _frozen = next.draft ? next.frozen : false;
  _workVersion++;
}

/**
 * Gesture end (U1/U2 commit seam). `changed` is the caller's EXPLICIT
 * verdict — a structural comparison of the working copy against the
 * gesture-start snapshot (GIMP's undo_motion flag: the history step's
 * existence is declared by the caller, never inferred by a reducer).
 *
 * - changed:  the working copy replaces `frame.drafts.pen` through the
 *   undoable `cmd.pen_set_draft` command (one gesture = one step) and the
 *   working copy is dropped — subsequent reads come from the frame. A
 *   gesture that emptied the session (the state machine returned
 *   `draft: null`, e.g. deleting the last anchor) clears the entry the same
 *   way — the frame must not keep a draft the session no longer holds.
 * - unchanged (a select-only click): the working copy is dropped and
 *   NOTHING is written — cancellation is untraceable by construction.
 */
export function endPenGesture(
  actions: EditorActions,
  frame: Frame | null | undefined,
  before: PenDraft | null,
  changed: boolean,
): void {
  const work = _work;
  _work = null;
  _workVersion++;
  if (!frame || !changed) return;
  if (!work) {
    if (before) persistPenDraft(actions, frame.id, null);
    return;
  }
  if (penDraftEquals(before, work)) return;
  persistPenDraft(actions, frame.id, work);
}

/** Deep structural comparison of two drafts (U1's has-change verdict). */
export function penDraftEquals(a: PenDraft | null, b: PenDraft | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.subpaths.length !== b.subpaths.length) return false;
  return a.subpaths.every((sub, i) => {
    const other = b.subpaths[i];
    if (sub.closed !== other.closed || sub.anchors.length !== other.anchors.length) return false;
    return sub.anchors.every((an, j) => {
      const bn = other.anchors[j];
      const handleEq = (p: { x: number; y: number } | null | undefined, q: { x: number; y: number } | null | undefined) =>
        p === q || (!!p && !!q && p.x === q.x && p.y === q.y);
      return an.x === bn.x && an.y === bn.y && handleEq(an.handleIn, bn.handleIn) && handleEq(an.handleOut, bn.handleOut);
    });
  });
}

/**
 * Persists a finished draft as ONE undoable document step. `null` clears
 * the entry (Clear Draft / commits). Records the written payload reference
 * so the lifecycle's resync pass can recognize this tool's own writes.
 * Callers MUST route through `cmd.pen_set_draft` (the undoable command) —
 * a bare `updateFrame` would bypass the history checkpoint.
 */
export function persistPenDraft(actions: EditorActions, frameId: string, draft: PenDraft | null): void {
  _lastWrite = draft ? { frameId, payload: draft } : null;
  actions.executeCommand(ADV_FRAME_SET_DRAFT, { frameId, toolId: PEN_TOOL_ID, payload: draft });
}

/** Overlay dirty-check input: gestures mutate the module copy, not the frame. */
export function getPenWorkVersion(): number {
  return _workVersion;
}

/** Drop the working copy without writing (external invalidation safety net). */
export function discardPenWork(): void {
  if (_work) {
    _work = null;
    _workVersion++;
  }
}

/** Clears the freeze intent (tool exit). */
export function clearPenFreezeIntent(): void {
  _frozen = false;
}

/**
 * Settles the freeze intent after an EXTERNAL draft change (the lifecycle's
 * resync pass). Receptiveness — "the next click extends this open tail" —
 * is granted only by this session's own drawing gestures (placing, resuming,
 * pulling handles). A draft that MATERIALIZED from elsewhere (undo of a
 * commit, Release Path to Draft, a frame switch, entering the tool over a
 * surviving work path) therefore starts FROZEN when its tail is open: the
 * rubber band stays hidden, the next click opens a new subpath, and the end
 * anchor (`/`) resumes it explicitly. A draft that merely CHANGED while the
 * session was live (undo of one anchor while drawing) keeps the tail
 * receptive so the line continues. Bumps the work version so the overlay
 * sync re-derives the band.
 */
export function settlePenFreezeIntent(draft: PenDraft | null, materialized: boolean): void {
  const tail = draft?.subpaths[draft.subpaths.length - 1];
  const openTail = !!tail && !tail.closed && tail.anchors.length > 0;
  const next = materialized && openTail;
  if (_frozen === next) return;
  _frozen = next;
  _workVersion++;
}

/**
 * Persistent screen-space rubber-band SVG group (black base line + white
 * dashed line, see PenRubberBand). Bound once by the component ref.
 */
let _rubberGroup: SVGGElement | null = null;
/** True once a start point has been placed; moves before that stay hidden. */
let _rubberPlaced = false;

export function setPenRubberLine(el: SVGGElement | null): void {
  _rubberGroup = el;
  _rubberPlaced = false;
}

/**
 * Anchors the band's start at the open subpath's last anchor (screen px) and
 * hides it until the next pointer move; null hides it outright. Called from
 * the surface sync whenever the fragment rebuilds or the camera moves.
 */
export function placePenRubberTip(pt: { x: number; y: number } | null): void {
  if (!_rubberGroup) return;
  _rubberPlaced = pt !== null;
  if (!pt) {
    _rubberGroup.setAttribute('visibility', 'hidden');
    return;
  }
  const x = String(pt.x);
  const y = String(pt.y);
  for (const line of _rubberGroup.children) {
    line.setAttribute('x1', x);
    line.setAttribute('y1', y);
  }
  _rubberGroup.setAttribute('visibility', 'hidden');
}

/**
 * Follows the cursor (screen px) by writing the endpoint attributes of both
 * band lines DIRECTLY — no store bump, no ticker dependency. Bare pointer
 * moves (no button held) do not wake the global ticker from its idle power
 * throttling, so a ticker-driven rubber band would stall to 4fps after two
 * idle seconds; a synchronous DOM write inside the pointermove listener has
 * no clock at all.
 */
export function movePenRubberTip(pt: { x: number; y: number }): void {
  if (!_rubberGroup || !_rubberPlaced) return;
  const x = String(pt.x);
  const y = String(pt.y);
  for (const line of _rubberGroup.children) {
    line.setAttribute('x2', x);
    line.setAttribute('y2', y);
  }
  _rubberGroup.setAttribute('visibility', 'visible');
}

// ─── Anchor hover highlight (direct DOM, no rebuild) ───────────────────────────

/**
 * The surface <g> holding the rebuilt fragment, bound once by the component
 * ref. Hover is applied by toggling `data-hover` on the matching
 * `[data-pen-anchor]` rect — the overlay is pointer-events-none and rebuilt
 * from strings, so CSS :hover cannot fire and a ticker-driven repaint would
 * lag at the idle 4fps; a synchronous attribute write in the pointermove
 * listener has neither problem. The CSS scale lives in PenSurface's style.
 */
let _surfaceGroup: SVGGElement | null = null;
let _hoverKey: string | null = null;

export function setPenSurfaceGroup(el: SVGGElement | null): void {
  _surfaceGroup = el;
  _hoverKey = null;
}

/**
 * Hover keys as emitted by render.ts: anchors `d:pi:ai` / `c:layerId:pi:ai`,
 * handle dots `hd:pi:ai:in|out` / `hc:layerId:pi:ai:in|out`. All hoverable
 * elements carry their key on `data-pen-el`; the hover write targets that.
 */
export function penDraftAnchorKey(pathIdx: number, anchorIdx: number): string {
  return `d:${pathIdx}:${anchorIdx}`;
}
export function penCommittedAnchorKey(layerId: string, pathIdx: number, anchorIdx: number): string {
  return `c:${layerId}:${pathIdx}:${anchorIdx}`;
}
export function penDraftHandleKey(pathIdx: number, anchorIdx: number, kind: 'handleIn' | 'handleOut'): string {
  return `hd:${pathIdx}:${anchorIdx}:${kind === 'handleIn' ? 'in' : 'out'}`;
}
export function penCommittedHandleKey(layerId: string, pathIdx: number, anchorIdx: number, kind: 'handleIn' | 'handleOut'): string {
  return `hc:${layerId}:${pathIdx}:${anchorIdx}:${kind === 'handleIn' ? 'in' : 'out'}`;
}

export function setPenAnchorHover(key: string | null): void {
  if (key === _hoverKey) return;
  _surfaceGroup?.querySelector('[data-pen-el][data-hover]')?.removeAttribute('data-hover');
  _hoverKey = key;
  if (key) _surfaceGroup?.querySelector(`[data-pen-el="${key}"]`)?.setAttribute('data-hover', '1');
}

/** Re-applies the current hover after the fragment was rebuilt (new nodes). */
export function refreshPenAnchorHover(): void {
  if (_hoverKey) _surfaceGroup?.querySelector(`[data-pen-el="${_hoverKey}"]`)?.setAttribute('data-hover', '1');
}

// ─── Session snapshot helper ───────────────────────────────────────────────────

/** Deep-clones the draft for gesture rollback snapshots (U1's `before`). */
export function snapshotPenDraft(draft: PenDraft | null): PenDraft | null {
  if (!draft) return null;
  return {
    subpaths: draft.subpaths.map((s) => ({
      closed: s.closed,
      anchors: s.anchors.map((a) => ({
        x: a.x, y: a.y,
        handleIn: a.handleIn ? { ...a.handleIn } : a.handleIn,
        handleOut: a.handleOut ? { ...a.handleOut } : a.handleOut,
      })),
    })),
  };
}

// ─── Selection accessors (tool state; never enters slots or snapshots) ─────────

export function getPenCommittedSelection(): PenSelection | null {
  return _selected;
}

export function setPenCommittedSelection(sel: PenSelection | null): void {
  _selected = sel;
  _selectionVersion++;
}

export function getPenDraftSelection(): PenDraftSelection | null {
  return _draftSelected;
}

export function setPenDraftSelection(sel: PenDraftSelection | null): void {
  _draftSelected = sel;
  _selectionVersion++;
}

/** Version counter for selection-only changes (overlay repaint dirty-check). */
export function getPenSelectionVersion(): number {
  return _selectionVersion;
}

// ─── Phase signal ──────────────────────────────────────────────────────────────

export function penPhaseFromDraft(draft: PenDraft | null): PenPhase {
  return draft ? 'drawing' : 'idle';
}

/**
 * Publishes the phase on real transitions only — callers guard against
 * no-op writes (a per-pointermove dispatch would re-render the whole
 * subscriber tree, exactly what the slow track exists to prevent).
 */
export function publishPenPhase(setSignal: SignalWriter, phase: PenPhase): void {
  setSignal(P.PenOverlayAPI.signals.phase, phase);
}

// ─── Shared gating ─────────────────────────────────────────────────────────────

/** Camera zoom for the active frame (screen px → canvas px conversion). */
export function cameraZoom(e: InteractionEvent): number {
  return e.actions.fast.latestCamera(e.activeFrame.id)?.k ?? 1;
}

/** Hit tolerance expressed in CANVAS px for the current zoom. */
export function canvasTolerance(e: InteractionEvent): number {
  return P.PEN_HIT_TOLERANCE_SCREEN_PX / cameraZoom(e);
}

/** Shared gating: pen craft active, not over UI/gizmo chrome, inside the canvas. */
export function passesBaseGate(e: InteractionEvent): boolean {
  if (e.state.interaction.interactionMode !== 'craft') return false;
  if (e.state.interaction.signals[ACTIVE_CRAFT_KEY] !== 'pen') return false;
  const target = e.nativeEvent.target as HTMLElement;
  if (target.closest('button, a, input, [data-role="ui"], [data-handle], [data-gizmo-handle], [data-gizmo-rotate]')) return false;
  const frame = e.activeFrame;
  return e.geometry.space.isPointInRect(e.point.canvas, {
    x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h,
  });
}

// ─── Committed-geometry hit tests ──────────────────────────────────────────────

/** Topmost committed-pen layer whose anchor/handle is within tolerance of `pt`. */
export function findAnchorHitAt(
  geometry: InteractionEvent['geometry'],
  frame: Frame,
  ptCanvas: { x: number; y: number },
  zoom: number,
): PenSelection | null {
  const ordered = frame.layers.order.map((id) => frame.layers.byId[id]).reverse();
  for (const layer of ordered) {
    // Hidden layers stay editable; fragment-triplet sub-layers (role
    // frag/exchange) are engine clones that must never hit — host only.
    if (!layer || layer.type !== 'vector' || !layer.penData || layer.locked || (layer.role && layer.role !== 'host')) continue;
    const mapping = makeLayerPointMapping(geometry.transform.getLayerLocalMatrix(layer, frame));
    const localPt = mapping.toLayer(ptCanvas);
    const tol = screenToleranceToLayer(P.PEN_HIT_TOLERANCE_SCREEN_PX, zoom, mapping);
    const hit = geometry.bezier.nearestPathAnchor(layer.penData, localPt, tol);
    if (hit) return { ...hit, layerId: layer.id };
  }
  return null;
}

/** InteractionEvent convenience wrapper over {@link findAnchorHitAt}. */
export function findAnchorHit(e: InteractionEvent, ptCanvas: { x: number; y: number }): PenSelection | null {
  return findAnchorHitAt(e.geometry, e.activeFrame, ptCanvas, cameraZoom(e));
}

/**
 * Topmost committed-pen layer whose CURVE passes within tolerance of `pt`.
 * The tolerance is doubled versus anchors: a segment is a lower-value target
 * and must never win over an anchor hit (callers try anchors first anyway),
 * but should not demand pixel-perfect aim either.
 */
export function findSegmentHitAt(
  geometry: InteractionEvent['geometry'],
  frame: Frame,
  ptCanvas: { x: number; y: number },
  zoom: number,
): { layerId: string; pathIdx: number; segIdx: number; t: number } | null {
  const ordered = frame.layers.order.map((id) => frame.layers.byId[id]).reverse();
  for (const layer of ordered) {
    // Hidden layers stay editable; fragment-triplet sub-layers (role
    // frag/exchange) are engine clones that must never hit — host only.
    if (!layer || layer.type !== 'vector' || !layer.penData || layer.locked || (layer.role && layer.role !== 'host')) continue;
    const mapping = makeLayerPointMapping(geometry.transform.getLayerLocalMatrix(layer, frame));
    const localPt = mapping.toLayer(ptCanvas);
    const tol = 2 * screenToleranceToLayer(P.PEN_HIT_TOLERANCE_SCREEN_PX, zoom, mapping);

    let best: { pathIdx: number; segIdx: number; t: number; dist: number } | null = null;
    layer.penData.paths.forEach((sub, pathIdx) => {
      const segs = geometry.bezier.penPathToCubicSegments({ paths: [sub] });
      const near = geometry.bezier.nearestPointOnPath(segs, localPt, tol);
      if (!near) return;
      if (!best || near.dist < best.dist) best = { pathIdx, segIdx: near.segmentIndex, t: near.t, dist: near.dist };
    });
    if (best) {
      const hit = best as { pathIdx: number; segIdx: number; t: number };
      return { layerId: layer.id, pathIdx: hit.pathIdx, segIdx: hit.segIdx, t: hit.t };
    }
  }
  return null;
}

/** InteractionEvent convenience wrapper over {@link findSegmentHitAt}. */
export function findSegmentHit(e: InteractionEvent, ptCanvas: { x: number; y: number }): { layerId: string; pathIdx: number; segIdx: number; t: number } | null {
  return findSegmentHitAt(e.geometry, e.activeFrame, ptCanvas, cameraZoom(e));
}

/**
 * Topmost committed-pen layer whose geometry (anchor OR curve) is within
 * tolerance of `pt`. Shared by the whole-layer move handler's test and the
 * lifecycle's Cmd-hover cursor: Cmd is the explicit "transform, don't draw"
 * modifier, and both surfaces must agree on what it will claim.
 */
export function findCommittedPenLayerAt(
  geometry: InteractionEvent['geometry'],
  frame: Frame,
  ptCanvas: { x: number; y: number },
  zoom: number,
): string | null {
  return findAnchorHitAt(geometry, frame, ptCanvas, zoom)?.layerId
    ?? findSegmentHitAt(geometry, frame, ptCanvas, zoom)?.layerId
    ?? null;
}

/**
 * Topmost committed-pen layer whose VISIBLE SHAPE contains `pt` — the same
 * pick the whole-layer move handler and the pan-mode double-click activator
 * use. Mirrors MarkerOverlay's findMarkerLayerAtPoint: `pickLayersAt` runs
 * `testLayerHit` per layer (visibleShape in layer-local space through the
 * world matrix inverse; falls back to the bounding rect), and we take the
 * first HOST pen layer top-down. Host-only: fragment-triplet sub-layers
 * (frag/exchange) are engine clones and never hit.
 */
export function findPenLayerBoxAt(
  geometry: InteractionEvent['geometry'],
  frame: Frame,
  ptCanvas: { x: number; y: number },
): string | null {
  const worldPoint = geometry.space.localToWorld(ptCanvas.x, ptCanvas.y, frame);
  const hits = geometry.space.pickLayersAt(worldPoint, frame.layers);
  const hit = hits.find((l: Layer) =>
    l.type === 'vector' && !!l.penData && l.visible && !l.locked && (!l.role || l.role === 'host'),
  );
  return hit?.id ?? null;
}

// ─── Mutators for commands / lifecycle ─────────────────────────────────────────

/**
 * Replaces the draft from OUTSIDE the interaction handlers (import /
 * release / discard) and drops both selections. Persists through the
 * undoable draft command, so the replacement is one document step (undo
 * restores the previous draft). The replacement is a MATERIALIZED draft
 * (not drawn by this session's gestures), so its open tail — if any —
 * starts frozen, the same rule the lifecycle applies to external changes.
 * Callers own the phase publication around this write.
 */
export function replacePenDraft(
  actions: EditorActions,
  frame: Frame,
  draft: PenDraft | null,
): void {
  _selected = null;
  _draftSelected = null;
  _selectionVersion++;
  settlePenFreezeIntent(draft, true);
  persistPenDraft(actions, frame.id, draft);
}
