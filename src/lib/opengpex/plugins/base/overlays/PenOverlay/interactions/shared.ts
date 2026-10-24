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
 * - The DRAFT (in-progress path) lives in the scratch service's per-frame
 *   slot ('penDraft'), opened via `actions.scratch.begin` on the first anchor
 *   of a session. Session-scoped undo/redo is owned by `actions.history`'s
 *   takeover point — handlers never keep their own undo stacks; they only
 *   record PRE-gesture snapshots via `actions.scratch.record`.
 * - Tool-side state (the committed-path selection and the draft-anchor
 *   selection) stays in this module store: it is ephemeral UI state that
 *   must not enter slots or undo snapshots.
 * - The rubber band and the anchor-hover highlight are direct DOM writes
 *   into the overlay's SVG (bound once by component refs) — the overlay is
 *   pointer-events-none and rebuilt from strings, so CSS :hover cannot fire
 *   and ticker-driven updates stall at the idle 4fps; synchronous writes in
 *   the pointer event have neither problem.
 *
 * Handler routes (priority-based arbitration): a press that lands on
 * committed path geometry is taken by pen-edit; anything else falls through
 * to the draft. During a draft session pen-edit yields (its test requires
 * the slot draft to be null), so every click continues the session.
 */

import {
  type EditorActions,
  type Frame,
  type InteractionEvent,
  type InteractionSignalValue,
  type Layer,
  PEN_DRAFT_SLOT_ID,
} from '@opengpex/editor/core/types';
import { CraftDrawerAPI } from '../../../drawers/CraftDrawer/protocols';
import * as P from '../protocols';
import type { PenDraft, PenDraftSelection, PenPhase, PenSelection } from '../pen/penState';
import type { PenToolState } from '../pen/penState';
import { makeLayerPointMapping, screenToleranceToLayer } from '../pen/geometry';

export const ACTIVE_CRAFT_KEY = CraftDrawerAPI.signals.activeCraft;

/** Scratch slot id holding the pen draft payload (JSON, frame-local anchors).
 *  The id lives in core (PEN_DRAFT_SLOT_ID) so viewport transforms can reach
 *  the draft; aliased here for the plugin's own call sites. */
export const PEN_DRAFT_SLOT = PEN_DRAFT_SLOT_ID;
/** Owner tool id used when opening the pen scratch session. */
export const PEN_SESSION_OWNER = P.PLUGIN_ID;

export type ScratchFacade = EditorActions['scratch'];
export type SignalWriter = (key: string, value: InteractionSignalValue) => void;

// ─── Tool-side store (module-level, cross-React-boundary) ──────────────────────

let _selected: PenSelection | null = null;
let _draftSelected: PenDraftSelection | null = null;
/** Bumped on selection-only changes so the overlay repaint dirty-check sees them. */
let _selectionVersion = 0;

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

// ─── Slot / tool-state composition helpers ─────────────────────────────────────

export function getPenDraft(scratch: ScratchFacade, frameId: string): PenDraft | null {
  return (scratch.get(frameId, PEN_DRAFT_SLOT) as PenDraft | undefined) ?? null;
}

/** Assembles the pure state machine's view: slot draft + module selection. */
export function composePenToolState(scratch: ScratchFacade, frameId: string): PenToolState {
  return { draft: getPenDraft(scratch, frameId), selected: _selected };
}

/**
 * Writes a state-machine result back: the draft half into the scratch slot,
 * the selection half into the module store. Pure slot write — no revision
 * dispatch (gesture-granular Redux visibility comes from scratch.record).
 * Handler-internal (draw gesture loop only).
 */
export function commitPenToolState(next: PenToolState, scratch: ScratchFacade, frameId: string): void {
  scratch.set(frameId, PEN_DRAFT_SLOT, next.draft);
  _selected = next.selected;
}

/** Deep-clones the draft for gesture rollback snapshots. */
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
 * Replaces the draft from outside the interaction handlers (commit / import /
 * discard) and drops both selections. Callers own the session begin/end and
 * the phase publication around this write.
 */
export function replacePenDraft(
  draft: PenDraft | null,
  scratch: ScratchFacade,
  frameId: string,
): void {
  scratch.set(frameId, PEN_DRAFT_SLOT, draft);
  _selected = null;
  _draftSelected = null;
  _selectionVersion++;
}
