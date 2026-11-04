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

import { useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useEditorState, useEditorServices } from '@opengpex/editor/core/context';
import { asLocalShape } from '@opengpex/editor/core/types';
import type { Frame, CameraState, ScreenRotationBox } from '@opengpex/editor/core/types';
import { getRegularClipShape } from '@opengpex/editor/core/helpers/selection';
import { readPeelSession, fragmentTrueRotationDeg } from './peel/session';
import { hitTestSelectionInterior } from './interactions/hitTest';
import * as P from './protocols';
import {
  ClipOptionsAPI,
  CLIP_TOOL_STRATEGIES,
  ClipTool,
} from '../../options/ClipOptions/protocols';
import type { ClipToolAAMap } from '../../options/ClipOptions/protocols';
import { CLIP_ELLIPSE_AA_OFF_CURSOR } from '@opengpex/editor/icons';

/**
 * useClipOverlayCommands: Encapsulates UI helper logic and command proxies
 * for the clipping overlay.
 */
export function useClipOverlayCommands() {
  const { state, activeFrame } = useEditorState();
  const { actions, geometry } = useEditorServices();
  const resetBox = () => actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);

  const boxRef = useRef<HTMLDivElement>(null);

  const isReCanvas = state.getStateSignal(ClipOptionsAPI.signals.reCanvas);
  const isClipActive = state.interaction.interactionMode === 'clip';

  // Re-Canvas is a modal that owns EVERY press (its handler claims resize,
  // move and redraw intents for the whole canvas). While it is active the
  // spring key must stand down entirely — otherwise Cmd would show a move
  // cursor that lies (the press goes to the canvas box, not a layer) and the
  // dispatcher would filter the modal's handler out. Cleanup restores the
  // default (unsuppressed) so the spring key survives unmount.
  useEffect(() => {
    actions.fast.spring.setSuppressed(isReCanvas);
    return () => actions.fast.spring.setSuppressed(false);
  }, [isReCanvas, actions]);

  // Active clip / selection tool — read from per-frame field.
  const rawTool = (activeFrame?.latestClipTool as ClipTool) || 'rect';

  // Re-Canvas pins tool to 'rect' (canvas resize is always rectangular).
  const clipTool: ClipTool = isReCanvas ? 'rect' : (CLIP_TOOL_STRATEGIES[rawTool] ? rawTool : 'rect');
  const family = CLIP_TOOL_STRATEGIES[clipTool].family;
  const isRegularTool = family === 'regular';

  const { confinement, canvasClipBox, canvas: canvasDim } = activeFrame || {
    confinement: null,
    canvasClipBox: asLocalShape({ x: 0, y: 0, w: 0, h: 0 }),
    canvas: { w: 0, h: 0 }
  };

  const imageClipBox = getRegularClipShape({ confinement });
  const clipShape = isReCanvas ? canvasClipBox : (imageClipBox ? geometry.polygon.polygonToShape(imageClipBox) : asLocalShape({ x: 0, y: 0, w: 0, h: 0 }));
  const clipBox = clipShape.rect;
  const clipType = clipShape.type;

  // Unmount cleanup: settle any undecided peel session as a DISCARD (the
  // "cancelled" semantic — identical to Esc). Idempotent: after a commit the
  // session record is gone and this is a zero-cost no-op; while a commit is
  // in flight the settle lock voids this call instead of rolling it back.
  // [noundo] settle is called via `.noundo()` because this cleanup runs
  // inside the peel interaction transaction — the undo boundary is already
  // owned by `peelToExchange`. Creating a checkpoint here would produce a
  // spurious undo step. See peel.ts for architecture notes.
  const actionsRef = useRef(actions);
  useLayoutEffect(() => {
    actionsRef.current = actions;
  });

  // The raw session payload reference present at MOUNT time. The unmount
  // fallback below must never discard a session that predates its own
  // overlay instance: React StrictMode (dev) drills every component with a
  // mount → cleanup → mount cycle right at boot, and the first cleanup's
  // discard used to land on the JUST-RESTORED session — a page refresh then
  // swallowed the peel even though the record had been persisted. A session
  // whose raw payload reference is unchanged since mount came from disk
  // (restore) or from an earlier overlay lifetime; only a session CREATED
  // during this lifetime (a live peel this overlay witnessed) is this
  // overlay's to cancel. Reference identity suffices: every session write
  // goes through writeFrameDraft and produces a new object.
  const sessionAtMountRef = useRef<unknown>(null);
  const mountedFrameIdRef = useRef<string | null>(null);

  useEffect(() => {
    // Capture is MOUNT-ONLY by design: the fallback must compare the session
    // against the one present when THIS overlay instance came up, so later
    // renders must not refresh these refs (that would make every inherited
    // session look "created during the lifetime").
    sessionAtMountRef.current = activeFrame?.drafts?.peel ?? null;
    mountedFrameIdRef.current = activeFrame?.id ?? null;
    return () => {
      const actions = actionsRef.current;
      const frameId = mountedFrameIdRef.current;
      const sessionAtMount = sessionAtMountRef.current;
      const sessionNow = frameId
        ? (actions.fast.latestFrame(frameId)?.drafts?.peel ?? null)
        : null;
      // The session predates this overlay instance (restored from disk or
      // inherited): not this lifetime's to cancel.
      const sessionIsInherited = !!sessionNow && sessionNow === sessionAtMount;
      queueMicrotask(() => {
        // The discard (Esc semantics) applies only to a session this overlay
        // lifetime CREATED; an inherited session stays persisted and either
        // outlives the unmount or is settled by its owner.
        if (sessionIsInherited) return;
        void actions.executeCommand(P.CMD_PEEL_SETTLE, { mode: 'discard' });
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    activeFrame,
    clipBox,
    clipType,
    imageClipBox: imageClipBox || asLocalShape({ x: 0, y: 0, w: 0, h: 0 }),
    canvasClipBox,
    canvasDim,
    isReCanvas,
    isClipActive,
    clipTool,
    isRegularTool,
    boxRef,
    reset: resetBox
  };
}

// ─── useClipCursor ─────────────────────────────────────────────────────────────

// ─── Selection hover hit-test helpers ────────────────────────────────────────

/**
 * Directional resize cursor when the point sits within `threshold` (canvas
 * px) of a rect edge, null otherwise. Pure geometry over the axis-aligned
 * bounds — corners fall to the horizontal axis (the first match), matching
 * the previous edge-proximity behavior.
 */
function rectEdgeCursor(
  pt: { x: number; y: number },
  rect: { x: number; y: number; w: number; h: number } | undefined,
  threshold: number
): string | null {
  if (!rect || rect.w <= 0 || rect.h <= 0) return null;
  const inHRange = pt.x >= rect.x - threshold && pt.x <= rect.x + rect.w + threshold;
  const inVRange = pt.y >= rect.y - threshold && pt.y <= rect.y + rect.h + threshold;
  if (inHRange && Math.abs(pt.y - rect.y) <= threshold) return 'ns-resize';
  if (inHRange && Math.abs(pt.y - (rect.y + rect.h)) <= threshold) return 'ns-resize';
  if (inVRange && Math.abs(pt.x - rect.x) <= threshold) return 'ew-resize';
  if (inVRange && Math.abs(pt.x - (rect.x + rect.w)) <= threshold) return 'ew-resize';
  return null;
}

/**
 * useClipCursor: Sets the clip mode base cursor plus SELECTION-ENTITY-driven
 * hover cursors.
 *
 * The hover logic is shape-driven, not tool-driven: whatever tool is active,
 * the pointer feedback depends only on WHAT is under it — the frame-level
 * selection entity (`frame.confinement`, classified by `polygonToShape`):
 *
 *   - Shift/Alt held  → yield to the tool's drawing cursor (a boolean
 *     union/difference draw is the live intent; the move cursor would lie).
 *   - Pointer over a TransformGizmo hit zone (corner handle / outline edge
 *     strip / rotation dot) → not declared here; the gizmo's internal
 *     CursorService sync owns that hover.
 *   - Pointer inside ANY selection (rect bbox, ellipse interior, path rings
 *     via point-in-polygon) → 'move'. Edge-proximity resize cursors are NOT
 *     declared here for selections — the gizmo outline strips own the edges.
 *   - Everywhere else → falls through to the tool's registered base cursor.
 *
 * All values flow through the CursorService; no element-level CSS cursor is
 * written anywhere in the clip overlay (the viewport container's inline
 * resolved cursor inherits down the un-styled subtree).
 *
 * Re-Canvas keeps its own variant: crosshair base, edge-proximity resize on
 * the canvas box (it renders no gizmo), never 'move' (its press resizes the
 * canvas, not a selection).
 */
export function useClipCursor(
  isClipActive: boolean,
  clipTool: ClipTool,
  isReCanvas?: boolean
) {
  const { actions, geometry } = useEditorServices();
  const { state, activeFrame } = useEditorState();

  // Ref to keep latest frame accessible in the pointermove closure without
  // re-registering the listener on every frame change.
  const frameRef = useRef(activeFrame);
  useLayoutEffect(() => { frameRef.current = activeFrame; });

  // Track interaction state in a ref so edge-proximity cursor doesn't flicker
  // during active resize drags (the box moves while dragging, causing the
  // distance-to-edge calculation to oscillate).
  const isInteractingRef = useRef(false);
  useLayoutEffect(() => { isInteractingRef.current = !!state.interaction.isInteracting; });

  // Read AA state for dynamic cursor switching (pathellipse: dashed cursor when AA off).
  // A selection's own entity flag wins; with no selection on canvas the active
  // tool's persistent AA preset fills the fallback so the dashed cursor reflects
  // the toggle immediately, before anything is drawn.
  const toolAAMap = state.getStateSignal<ClipToolAAMap | null>(ClipOptionsAPI.signals.clipToolAA);
  const clipBox_AA = activeFrame?.confinement?.antiAliased
    ?? toolAAMap?.[clipTool] ?? true;

  useEffect(() => {
    if (isClipActive) {
      // Re-Canvas is a canvas-resize modal, not a selection tool: plain
      // crosshair (no tool subscript indicator that would misleadingly
      // suggest the rect selection tool is active).
      const toolCursor = isReCanvas
        ? 'crosshair'
        : clipTool === 'pathellipse' && !clipBox_AA
          ? CLIP_ELLIPSE_AA_OFF_CURSOR
          : CLIP_TOOL_STRATEGIES[clipTool].cursor;
      actions.fast.cursor.register('clip', toolCursor);
    } else {
      actions.fast.cursor.register('clip', null);
    }
  }, [isClipActive, isReCanvas, clipTool, clipBox_AA, actions]);

  // ─── Unified selection-entity hover cursor ─────────────────────────────
  // One document-level pointermove pass classifies the pointer against the
  // selection entity's shape (NOT the active tool), so hover feedback is
  // identical across rect / pathellipse / lasso / wand / sam.
  useEffect(() => {
    const isActive = isClipActive || !!isReCanvas;
    if (!isActive) return;

    const EDGE_THRESHOLD_PX = 6; // screen pixels

    const onPointerMove = (ev: PointerEvent) => {
      // Freeze hover updates during an active gesture: the selection moves
      // under the pointer, so inside/edge tests would oscillate and flicker
      // the cursor mid-drag. The gesture cursor (dragging channel) wins
      // anyway while a handler is live.
      if (isInteractingRef.current) return;

      // TransformGizmo hit zones own their own hover declaration (the gizmo's
      // internal CursorService sync) — hands off entirely so the two writers
      // never fight over the same move event.
      const el = ev.target as HTMLElement | null;
      if (el?.closest?.('[data-gizmo-cursor]')) return;

      const frame = frameRef.current;
      if (!frame) return;

      // Cmd/Ctrl engages the peel/spring channel: this pass must not write
      // the single hover slot at all while the spring key is held. The
      // workspace-level peel cursor hook (ClipOverlay/peel/usePeelCursor) is the
      // sole writer on that channel — it refines to the peel cut/copy cursors
      // inside the selection and stays silent elsewhere — and a null write
      // here would race and clobber that refinement (document-level
      // pointermove listeners fire in registration order, so whichever hook
      // registered later would win). Skipping keeps the two writers
      // complementary; the resolver maps an empty hover to the same spring
      // 'move' the old explicit write produced.
      // Re-Canvas is excluded: it suppresses the spring keys entirely and
      // its edge-proximity cursors must keep updating under modifiers.
      if (!isReCanvas && (ev.metaKey || ev.ctrlKey)) return;

      // Shift/Alt carry boolean union/difference semantics: the press is a
      // NEW selection draw even when it starts inside the existing selection
      // (move handlers are spring-filtered on those channels), so the move
      // cursor would lie. Yield → the tool's drawing cursor shows.
      // Re-Canvas has no boolean draw — its modifiers never yield.
      if (!isReCanvas && (ev.shiftKey || ev.altKey)) {
        actions.fast.cursor.notifyHover(null);
        return;
      }

      // Project pointer → canvas-local (same recipe as the hover-reveal hook).
      const container = document.querySelector('.editor-viewport-container');
      if (!container) return;
      const domRect = container.getBoundingClientRect();
      const vx = ev.clientX - domRect.left;
      const vy = ev.clientY - domRect.top;
      const currentCam = actions.fast.latestCamera(frame.id);
      const worldPt = geometry.space.screenToWorld(vx, vy, frame, currentCam);
      const canvasPt = geometry.space.worldToLocal(worldPt.x, worldPt.y, frame);

      // Screen-px thresholds → canvas-local px via camera scale.
      const k = currentCam?.k ?? frame.camera.k;
      const T = EDGE_THRESHOLD_PX / k;

      // Re-Canvas renders no gizmo: edge proximity against the canvas box is
      // still declared here.
      if (isReCanvas) {
        actions.fast.cursor.notifyHover(rectEdgeCursor(canvasPt, frame.canvasClipBox?.rect, T));
        return;
      }

      // No selection entity → tool base cursor everywhere.
      const poly = frame.confinement;
      if (!poly || !poly.rings || poly.rings.length === 0) {
        actions.fast.cursor.notifyHover(null);
        return;
      }

      // Interior hover → move; edges belong to the gizmo outline strips,
      // not to this pass. The predicate is the shared selection-interior
      // hit test so the hover cursor can never promise 'move' where the
      // move surface's DOM (border-radius 50% for ellipses) would not
      // accept the press.
      const desired = hitTestSelectionInterior(canvasPt, poly) ? 'move' : null;

      actions.fast.cursor.notifyHover(desired);
    };

    document.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      // Clear the hover declaration — let the service re-derive the cursor
      // from the remaining inputs.
      actions.fast.cursor.notifyHover(null);
    };
  }, [isClipActive, isReCanvas, actions, geometry]);

  useEffect(() => {
    return () => {
      actions.fast.cursor.register('clip', null);
      actions.fast.cursor.notifyHover(null);
    };
  }, [actions]);
}

// ─── Selection HUD anchor (affordances framework consumer) ──────────────────

/**
 * useSelectionHudAnchor: the selection's TRUE box in screen space for the
 * TransformHud framework — ONE anchor for every selection HUD flavor,
 * both flavors — but the ORIENTATION comes from the flavor's own state,
 * never guessed from the vertices (vertex probes misread every shape
 * whose ring does not start along its x-axis):
 *   - peel session → the fragment's TRUE pose (baked origin rotation +
 *     accRotation + the live field rotation, which streams through the
 *     buffered frame during gestures — bake-proof and live);
 *   - plain selection → 0° — the historical upright AABB (a plain
 *     selection has no persistent orientation record; its flat box was
 *     always the accepted presentation, bitwise preserved).
 * The box top-left and axis lengths are projected through the camera per
 * tick, which also folds any frame-level screen rotation into the
 * reported angle.
 */
export function useSelectionHudAnchor() {
  const { geometry } = useEditorServices();

  const sessionAngleRad = useCallback((f: Frame): number => {
    const session = readPeelSession(f);
    if (session && session.status === 'peeled') {
      const exchange = f.layers.byId[session.exchangeId];
      if (exchange) return (fragmentTrueRotationDeg(session, exchange) * Math.PI) / 180;
    }
    // Plain flavor: the selection's OWN orientation record (accumulated by
    // rotatePolygon since creation; 0° for a freshly drawn shape).
    return ((f.confinement?.orientationDeg ?? 0) * Math.PI) / 180;
  }, []);

  const getAnchorFrame = useCallback((
    _v: unknown,
    f: Frame,
    cam: CameraState,
  ): ScreenRotationBox | null => {
    const poly = f.confinement;
    if (!poly || poly.rect.w <= 0 || poly.rect.h <= 0) return null;
    const box = geometry.transform.rotatedPolygonBox(poly, sessionAngleRad(f));
    return geometry.transform.toScreenRotationBox(box, cam ?? f.camera);
  }, [geometry, sessionAngleRad]);

  const getDimensionText = useCallback((_v: unknown, f: Frame): string => {
    const poly = f.confinement;
    if (!poly) return '0 × 0';
    // Same recipe as the anchor: extents along the flavor's orientation
    // (session = true pose; plain = 0° → the historical AABB readout).
    const rf = geometry.transform.rotatedPolygonBox(poly, sessionAngleRad(f));
    return `${Math.round(rf.w)} × ${Math.round(rf.h)}`;
  }, [geometry, sessionAngleRad]);

  return { getAnchorFrame, getDimensionText };
}

