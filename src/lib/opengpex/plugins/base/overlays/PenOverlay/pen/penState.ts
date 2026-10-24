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
 * toolState.ts — Pure pen-tool state machine.
 *
 * Every transition of the pen drawing session is a pure function over an
 * immutable-ish `PenToolState`, so the whole interaction grammar (place,
 * drag handles, close, end, undo-pop, delete, smooth/corner toggle) is
 * unit-testable without any DOM, React or store. The live instance lives in
 * a module-level volatile store (see `interactions.ts`); React and the
 * interaction handlers read it through the same accessors.
 *
 * Coordinate contract: DRAFT anchors are FRAME-LOCAL (canvas) points. The
 * draft is a volatile in-progress session that must survive active-layer
 * switches and must not need a layer transform to render, so it is kept in
 * the same space the pointer reports; conversion to layer-local happens once
 * at commit time. COMMITTED paths (`PenPathData` on a layer) are
 * LAYER-LOCAL, per the payload's own contract.
 */

import type { PenAnchor, PenPathData, PenSubPath, Point2D } from '@opengpex/editor/core/types';

// ─── State shape ───────────────────────────────────────────────────────────────

/**
 * One in-progress subpath of the drawing session. Anchors are frame-local.
 */
export interface PenDraftSubPath {
  anchors: PenAnchor[];
  closed: boolean;
}

/** The volatile drawing session (`null` = no active session). */
export interface PenDraft {
  subpaths: PenDraftSubPath[];
}

/** Which subpath/anchor of a path is selected, and what part of the anchor. */
export interface PenSelection {
  /** Owning layer id (committed pen layers are the edit targets). */
  layerId: string;
  pathIdx: number;
  anchorIdx: number;
  kind: 'anchor' | 'handleIn' | 'handleOut';
}

export interface PenToolState {
  draft: PenDraft | null;
  /**
   * Selection on a COMMITTED path (layer's `penData`). Only meaningful while
   * `draft === null` — during a drawing session every click belongs to the
   * draft, so the selection is cleared whenever a session starts.
   */
  selected: PenSelection | null;
}

export const emptyPenToolState = (): PenToolState => ({ draft: null, selected: null });

/**
 * The pen tool's coarse phase, published as the scoped public `pen_phase`
 * signal. 'drawing' = a draft session holds the scratch slot; 'editing' is
 * reserved for the committed-path editing batch (Phase 3).
 */
export type PenPhase = 'idle' | 'drawing' | 'editing';

/** Draft-anchor selection (tool state, never enters a slot or undo stack). */
export interface PenDraftSelection {
  pathIdx: number;
  anchorIdx: number;
}

// ─── Draft session lifecycle ───────────────────────────────────────────────────

/** Opens a drawing session with one empty, open subpath ready for anchors. */
export function startDraft(_state: PenToolState): PenToolState {
  return { draft: { subpaths: [{ anchors: [], closed: false }] }, selected: null };
}

export function cancelDraft(state: PenToolState): PenToolState {
  return { ...state, draft: null, selected: null };
}

/**
 * The last subpath is "receptive" when it is open (its next anchor continues
 * it). After close/end, `advanceToReceptive` lazily opens a fresh subpath so
 * the next click starts a new one — holes come from drawing several closed
 * subpaths in one session (committed as evenodd rings).
 */
function receptive(draft: PenDraft): PenDraftSubPath {
  const last = draft.subpaths[draft.subpaths.length - 1];
  if (last && !last.closed) return last;
  const next: PenDraftSubPath = { anchors: [], closed: false };
  draft.subpaths.push(next);
  return next;
}


/**
 * Places a sharp anchor at `pt`. Continues the receptive subpath, or starts a
 * new one when the previous subpath was just closed/ended. No-op without a
 * session (handlers call `startDraft` first).
 */
export function placeAnchor(state: PenToolState, pt: Point2D): PenToolState {
  if (!state.draft) return state;
  const sub = receptive(state.draft);
  sub.anchors.push({ x: pt.x, y: pt.y, handleIn: null, handleOut: null });
  return { ...state };
}

/**
 * Drag-follow for the freshly placed anchor: pulls its outgoing handle toward
 * `cursor` (relative offset) and mirrors it into the incoming handle for a
 * smooth anchor. `altKey` breaks the symmetry (outgoing handle only). A
 * near-zero drag collapses both handles back to sharp.
 */
export function dragNewHandles(
  state: PenToolState,
  cursor: Point2D,
  altKey: boolean,
): PenToolState {
  const draft = state.draft;
  if (!draft) return state;
  const sub = draft.subpaths[draft.subpaths.length - 1];
  const anchor = sub?.anchors[sub.anchors.length - 1];
  if (!anchor) return state;

  const out = { x: cursor.x - anchor.x, y: cursor.y - anchor.y };
  if (Math.hypot(out.x, out.y) < 1) {
    anchor.handleOut = null;
    anchor.handleIn = null;
  } else {
    anchor.handleOut = out;
    // `|| 0` normalizes -0 so structural equality in tests/logs stays sane.
    anchor.handleIn = altKey ? null : { x: -out.x || 0, y: -out.y || 0 };
  }
  return { ...state };
}

/**
 * Gesture-end settle for the freshly placed anchor: a click without a real
 * drag collapses its residual handles back to sharp; a real drag keeps the
 * pulled handles EXACTLY as the last move left them (Alt asymmetry included).
 */
export function settleNewHandles(state: PenToolState): PenToolState {
  const draft = state.draft;
  if (!draft) return state;
  const sub = draft.subpaths[draft.subpaths.length - 1];
  const anchor = sub?.anchors[sub.anchors.length - 1];
  if (!anchor) return state;
  const out = anchor.handleOut;
  if (!out || Math.hypot(out.x, out.y) < 1) {
    anchor.handleOut = null;
    anchor.handleIn = null;
  }
  return { ...state };
}

/**
 * Closes the receptive subpath back onto its first anchor (click on the first
 * anchor). Requires ≥3 anchors so a closed ring is geometrically meaningful.
 * The session stays alive; the next click starts a new subpath.
 */
export function closeActiveSubpath(state: PenToolState): PenToolState {
  const draft = state.draft;
  if (!draft) return state;
  const sub = draft.subpaths[draft.subpaths.length - 1];
  if (!sub || sub.closed || sub.anchors.length < CLOSE_MIN_ANCHORS) return state;
  sub.closed = true;
  return { ...state };
}

/**
 * Enter key: finishes the receptive open subpath in place (it stays open in
 * the committed sense — an unfinished but frozen polyline). A new subpath is
 * opened lazily by the next placement.
 */
export function endActiveSubpath(state: PenToolState): PenToolState {
  const draft = state.draft;
  if (!draft) return state;
  const sub = draft.subpaths[draft.subpaths.length - 1];
  if (!sub || sub.closed) return state;
  if (sub.anchors.length < 2) {
    // A lone dangling anchor carries no geometry — drop it.
    if (sub.anchors.length === 1 && draft.subpaths.length === 1) {
      return cancelDraft(state);
    }
    draft.subpaths.pop();
    return { ...state };
  }
  // Freeze this subpath: the next placement must open a NEW one, so push an
  // empty receptive subpath now (empties are filtered at projection).
  draft.subpaths.push({ anchors: [], closed: false });
  return { ...state };
}

/**
 * Index of the FROZEN open subpath whose END anchor lies within `tol` of
 * `pt`, or -1. Frozen = open, non-empty, and not the receptive (last)
 * subpath — i.e. a polyline that Enter froze earlier in this session. Hit
 * from the newest subpath backwards so overlapping endpoints resolve to the
 * most recent one.
 */
export function hitFrozenSubpathEnd(state: PenToolState, pt: Point2D, tol: number): number {
  const subs = state.draft?.subpaths;
  if (!subs) return -1;
  for (let pi = subs.length - 2; pi >= 0; pi--) {
    const sub = subs[pi];
    if (sub.closed || sub.anchors.length === 0) continue;
    const end = sub.anchors[sub.anchors.length - 1];
    if (Math.hypot(end.x - pt.x, end.y - pt.y) <= tol) return pi;
  }
  return -1;
}

/**
 * Resumes a frozen open subpath (Photoshop's "click the endpoint to continue
 * the path"): it becomes the receptive subpath again so the next placement
 * extends it and clicking its first anchor closes it. Implemented by moving
 * it to the end of the list (subpath order carries no geometric meaning —
 * fill/mask classification is containment-based) and dropping the empty
 * receptive marker Enter left behind. Pure bookkeeping with no visible
 * change: callers must NOT record it as a session step.
 */
export function resumeFrozenSubpath(state: PenToolState, pathIdx: number): PenToolState {
  const draft = state.draft;
  if (!draft) return state;
  const sub = draft.subpaths[pathIdx];
  if (!sub || sub.closed || sub.anchors.length === 0) return state;
  draft.subpaths.splice(pathIdx, 1);
  while (draft.subpaths.length > 0 && draft.subpaths[draft.subpaths.length - 1].anchors.length === 0) {
    draft.subpaths.pop();
  }
  draft.subpaths.push(sub);
  return { ...state };
}

/**
 * In-session undo: pops the last placed anchor. When its subpath empties and
 * it is not the only subpath, the husk is removed too. Empties to
 * `draft: null` when nothing is left (session over).
 */
export function popLastAnchor(state: PenToolState): PenToolState {
  const draft = state.draft;
  if (!draft) return state;
  for (let i = draft.subpaths.length - 1; i >= 0; i--) {
    const sub = draft.subpaths[i];
    if (sub.anchors.length === 0) continue;
    sub.anchors.pop();
    // Popping a closed ring below its 3-anchor minimum reopens it so the
    // session continues placing instead of holding a dead husk.
    if (sub.closed && sub.anchors.length < MIN_CLOSED_ANCHORS) sub.closed = false;
    if (sub.anchors.length === 0 && draft.subpaths.length > 1) draft.subpaths.splice(i, 1);
    break;
  }
  const alive = draft.subpaths.some((s) => s.anchors.length > 0);
  return alive ? { ...state } : cancelDraft(state);
}

/** Deletes one anchor from the draft; an anchor-less subpath is removed. */
export function deleteDraftAnchor(state: PenToolState, pathIdx: number, anchorIdx: number): PenToolState {
  const draft = state.draft;
  if (!draft) return state;
  const sub = draft.subpaths[pathIdx];
  if (!sub) return state;
  sub.anchors.splice(anchorIdx, 1);
  // Below the 2-anchor geometric minimum a subpath carries nothing — drop it
  // (mirrors deleteCommittedAnchor's lifetime rule).
  if (sub.anchors.length < (sub.closed ? MIN_CLOSED_ANCHORS : MIN_OPEN_ANCHORS)) {
    draft.subpaths.splice(pathIdx, 1);
  }
  const alive = draft.subpaths.some((s) => s.anchors.length > 0);
  return alive ? { ...state, selected: null } : cancelDraft(state);
}

/** Moves a draft anchor (its relative handles travel with it). */
function moveDraftAnchor(
  state: PenToolState,
  pathIdx: number,
  anchorIdx: number,
  pt: Point2D,
): PenToolState {
  const anchor = state.draft?.subpaths[pathIdx]?.anchors[anchorIdx];
  if (!anchor) return state;
  anchor.x = pt.x;
  anchor.y = pt.y;
  return { ...state };
}

/**
 * Drags ONE PART of a draft anchor: 'anchor' moves the anchor itself (its
 * relative handles travel along); 'handleIn'/'handleOut' moves that handle
 * to `pt` (absolute), mirroring the opposite handle unless `breakSymmetry`
 * (Alt) — the mirror only applies when the opposite side has a handle.
 * Mutates the draft in place, mirroring `dragCommittedAnchor`'s contract.
 */
export function dragDraftAnchorPart(
  state: PenToolState,
  pathIdx: number,
  anchorIdx: number,
  kind: PenSelection['kind'],
  pt: Point2D,
  breakSymmetry: boolean,
): PenToolState {
  const anchor = state.draft?.subpaths[pathIdx]?.anchors[anchorIdx];
  if (!anchor) return state;
  if (kind === 'anchor') return moveDraftAnchor(state, pathIdx, anchorIdx, pt);
  const rel = { x: pt.x - anchor.x, y: pt.y - anchor.y };
  const otherKey = kind === 'handleIn' ? 'handleOut' : 'handleIn';
  const other = anchor[otherKey];
  anchor[kind] = rel;
  if (!breakSymmetry && other) {
    anchor[otherKey] = { x: -rel.x || 0, y: -rel.y || 0 };
  }
  return { ...state };
}

/**
 * Toggles an anchor between sharp (both handles null) and smooth (symmetric
 * auto handles along the neighbor chord). Draft variant.
 */
export function toggleDraftAnchorSmooth(
  state: PenToolState,
  pathIdx: number,
  anchorIdx: number,
): PenToolState {
  const sub = state.draft?.subpaths[pathIdx];
  const anchor = sub?.anchors[anchorIdx];
  if (!sub || !anchor) return state;
  applySmoothToggle(anchor, sub.anchors, anchorIdx, sub.closed);
  return { ...state };
}

// ─── Commit-shaped outputs ─────────────────────────────────────────────────────

/**
 * Minimum anchors for a closed ring to carry geometry. Two is enough (two
 * arcs = a lens/ellipse); the Schneider fit legitimately emits 2-anchor
 * closed rings for near-circular imported holes, and those must survive
 * projection and commit.
 */
const MIN_CLOSED_ANCHORS = 2;
/**
 * Interactive gate for clicking an open subpath shut: three anchors, so an
 * accidental double-click can never produce a degenerate 2-anchor loop while
 * drawing (imports are not gated — their ring came from real geometry).
 */
const CLOSE_MIN_ANCHORS = 3;
/** Minimum anchors for an open subpath to carry geometry (a segment). */
const MIN_OPEN_ANCHORS = 2;

/**
 * True when an OPEN subpath encloses area once implicitly closed: 3+ anchors
 * form a real polygon with the closing chord, but exactly 2 anchors only do
 * so when at least one bézier handle bows the segment away from the chord —
 * a 2-anchor straight polyline closes to zero area (an invisible shape
 * layer / empty selection), so it is NOT committable.
 */
export function openSubpathHasArea(sub: PenDraftSubPath): boolean {
  if (sub.anchors.length >= 3) return true;
  if (sub.anchors.length < 2) return false;
  return sub.anchors.some((a) => !!a.handleIn || !!a.handleOut);
}

/** True when the session holds at least one committable closed ring. */
export function hasClosedSubpath(state: PenToolState): boolean {
  return !!state.draft?.subpaths.some((s) => s.closed && s.anchors.length >= MIN_CLOSED_ANCHORS);
}

/** True when the session holds anything committable at all. */
export function hasCommittableGeometry(state: PenToolState): boolean {
  return !!state.draft?.subpaths.some((s) =>
    s.closed ? s.anchors.length >= MIN_CLOSED_ANCHORS : openSubpathHasArea(s));
}

/** Total anchors across the draft (HUD diagnostics). */
export function draftAnchorCount(state: PenToolState): number {
  return state.draft?.subpaths.reduce((sum, s) => sum + s.anchors.length, 0) ?? 0;
}

/** Projects the draft into the persistent `PenPathData` shape (empties dropped). */
export function draftToPenPathData(state: PenToolState): PenPathData {
  const paths: PenSubPath[] = (state.draft?.subpaths ?? [])
    .filter((s) => (s.closed ? s.anchors.length >= MIN_CLOSED_ANCHORS : openSubpathHasArea(s)))
    .map((s) => ({ anchors: s.anchors.map((a) => ({ ...a })), closed: s.closed }));
  return { paths };
}

/**
 * Flattened ring extraction happens on the commit side (needs the bézier
 * service); this returns the committable subpaths in session order.
 */
export function committableSubpaths(state: PenToolState): PenDraftSubPath[] {
  return (state.draft?.subpaths ?? []).filter((s) =>
    s.closed ? s.anchors.length >= MIN_CLOSED_ANCHORS : openSubpathHasArea(s));
}

// ─── Segment insertion (click on a committed path's curve) ────────────────────

/** de Casteljau split of one cubic at t into two halves joining at B(t). */
function splitCubicLocal(p0: Point2D, p1: Point2D, p2: Point2D, p3: Point2D, t: number) {
  const lerp = (a: Point2D, b: Point2D): Point2D => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });
  const a = lerp(p0, p1);
  const b = lerp(p1, p2);
  const c = lerp(p2, p3);
  const d = lerp(a, b);
  const e = lerp(b, c);
  const m = lerp(d, e);
  return { left: [p0, a, d, m] as const, right: [m, e, c, p3] as const, m };
}

/**
 * Inserts an anchor into subpath `pathIdx` at parameter `t` of its segment
 * `segIdx` (de Casteljau split; both halves keep the original curve shape
 * bit-for-bit). Closed subpaths address their closing segment as
 * `segIdx === anchors.length`. Returns the new anchor index, or null when
 * the indices are out of range.
 */
export function insertAnchorOnSegment(
  path: PenPathData,
  pathIdx: number,
  segIdx: number,
  t: number,
): { path: PenPathData; anchorIdx: number } | null {
  const sub = path.paths[pathIdx];
  if (!sub) return null;
  const a = sub.anchors;
  if (a.length < 2) return null;
  const count = sub.closed ? a.length : a.length - 1;
  if (segIdx < 0 || segIdx >= count) return null;

  const from = a[segIdx];
  const to = a[(segIdx + 1) % a.length];
  const c1 = from.handleOut ? { x: from.x + from.handleOut.x, y: from.y + from.handleOut.y } : from;
  const c2 = to.handleIn ? { x: to.x + to.handleIn.x, y: to.y + to.handleIn.y } : to;
  const { left, right, m } = splitCubicLocal(
    { x: from.x, y: from.y }, c1, c2, { x: to.x, y: to.y }, t,
  );

  const rel = (base: Point2D, pt: Point2D): { x: number; y: number } | null => {
    const v = { x: pt.x - base.x, y: pt.y - base.y };
    return Math.hypot(v.x, v.y) < 1e-9 ? null : v;
  };

  // left = [from, a, d, m], right = [m, e, c, to]: the outer control points
  // become the anchors' new handles. When the ORIGINAL side had no handle the
  // incoming geometry was straight; keep it visually straight by nulling the
  // new handle when it is collinear with the (anchor → split point) chord —
  // same shape, no spurious handle lines on straight segments.
  const collinear = (base: Point2D, ctrl: Point2D, tip: Point2D): boolean => {
    const v1x = ctrl.x - base.x, v1y = ctrl.y - base.y;
    const v2x = tip.x - base.x, v2y = tip.y - base.y;
    return Math.abs(v1x * v2y - v1y * v2x) < 1e-9;
  };
  const nextFrom = { ...from };
  nextFrom.handleOut = from.handleOut
    ? rel(from, left[1])
    : collinear(from, left[1], m) ? null : rel(from, left[1]);
  const nextTo = { ...to };
  nextTo.handleIn = to.handleIn
    ? rel(to, right[2])
    : collinear(to, right[2], m) ? null : rel(to, right[2]);
  const inserted: PenAnchor = {
    x: m.x, y: m.y,
    handleIn: rel(m, left[2]) ?? null,
    handleOut: rel(m, right[1]) ?? null,
  };

  const anchors = a.slice();
  anchors[segIdx] = nextFrom;
  if (segIdx === count - 1 && sub.closed) {
    // The closing segment: `to` is anchor 0; the new anchor appends at the end.
    anchors[0] = nextTo;
    anchors.push(inserted);
  } else {
    anchors[segIdx + 1] = nextTo;
    anchors.splice(segIdx + 1, 0, inserted);
  }
  const paths = path.paths.slice();
  paths[pathIdx] = { ...sub, anchors };
  return { path: { paths }, anchorIdx: sub.closed && segIdx === count - 1 ? anchors.length - 1 : segIdx + 1 };
}

// ─── Committed-path selection helpers ─────────────────────────────────────────

export function selectCommittedAnchor(
  state: PenToolState,
  sel: PenSelection | null,
): PenToolState {
  return { ...state, selected: sel };
}

/** Removes an anchor from a committed path (pure; caller persists via tx). */
export function deleteCommittedAnchor(
  path: PenPathData,
  sel: PenSelection,
): PenPathData | null {
  const sub = path.paths[sel.pathIdx];
  if (!sub) return path;
  const anchors = sub.anchors.slice();
  anchors.splice(sel.anchorIdx, 1);
  if (anchors.length < (sub.closed ? MIN_CLOSED_ANCHORS : MIN_OPEN_ANCHORS)) {
    // The subpath dies below its geometric minimum; delete it entirely.
    const paths = path.paths.filter((_, i) => i !== sel.pathIdx);
    return paths.length > 0 ? { paths } : null;
  }
  const paths = path.paths.slice();
  paths[sel.pathIdx] = { ...sub, anchors };
  return { paths };
}

// ─── Shared geometry primitives (pure; service-free on purpose) ────────────────

/**
 * Sharp ↔ smooth toggle for one anchor inside an anchor chain. Sharp → smooth
 * generates symmetric handles along the chord between the two ring neighbors
 * (a quarter of the chord each side — a stable, scale-free default that reads
 * as "gently rounded" whatever the path). Smooth → sharp nulls both handles.
 */
export function applySmoothToggle(
  anchor: PenAnchor,
  anchors: readonly PenAnchor[],
  idx: number,
  closed: boolean,
): void {
  const isSmooth = anchor.handleIn != null || anchor.handleOut != null;
  if (isSmooth) {
    anchor.handleIn = null;
    anchor.handleOut = null;
    return;
  }
  const n = anchors.length;
  if (n < 2) return;
  const prev = anchors[closed ? (idx - 1 + n) % n : Math.max(0, idx - 1)];
  const next = anchors[closed ? (idx + 1) % n : Math.min(n - 1, idx + 1)];
  if (prev === anchor || next === anchor) return;
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  anchor.handleIn = { x: (-dx / len) * len * 0.25, y: (-dy / len) * len * 0.25 };
  anchor.handleOut = { x: (dx / len) * len * 0.25, y: (dy / len) * len * 0.25 };
}


/**
 * Moving one part of an anchor produces the next anchor state. `kind`
 * 'anchor' moves the anchor itself (handles travel along, they are relative);
 * 'handleIn'/'handleOut' moves that handle to `pt` (absolute), mirroring the
 * opposite handle unless `breakSymmetry` (Alt) — the mirror is only applied
 * when the opposite side actually had a handle.
 */
export function dragCommittedAnchor(
  path: PenPathData,
  sel: PenSelection,
  pt: Point2D,
  breakSymmetry: boolean,
): PenPathData {
  const sub = path.paths[sel.pathIdx];
  if (!sub) return path;
  const anchor = sub.anchors[sel.anchorIdx];
  if (!anchor) return path;

  if (sel.kind === 'anchor') {
    return replaceAnchor(path, sel, { ...anchor, x: pt.x, y: pt.y });
  }

  const rel = { x: pt.x - anchor.x, y: pt.y - anchor.y };
  const next = { ...anchor };
  const otherKey = sel.kind === 'handleIn' ? 'handleOut' : 'handleIn';
  const other = anchor[otherKey];
  next[sel.kind] = rel;
  if (!breakSymmetry && other) {
    next[otherKey] = { x: -rel.x || 0, y: -rel.y || 0 };
  }
  return replaceAnchor(path, sel, next);
}

function replaceAnchor(path: PenPathData, sel: PenSelection, anchor: PenAnchor): PenPathData {
  const sub = path.paths[sel.pathIdx];
  if (!sub) return path;
  const anchors = sub.anchors.slice();
  anchors[sel.anchorIdx] = anchor;
  const paths = path.paths.slice();
  paths[sel.pathIdx] = { ...sub, anchors };
  return { paths };
}
