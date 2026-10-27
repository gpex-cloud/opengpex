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

import { useRef, useEffect, useLayoutEffect, type RefObject } from 'react';
import { useEditorState, useEditorServices } from '@opengpex/editor/core/context';
import { asLocalShape } from '@opengpex/editor/core/types';
import { getRegularClipShape } from '@opengpex/editor/core/helpers/selection';
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

  // Unmount cleanup: discard any in-flight peel.
  // [noundo] discardExchange is called via `.noundo()` because this cleanup
  // runs inside the peel interaction transaction — the undo boundary is already
  // owned by `peelToExchange`. Creating a checkpoint here would produce a
  // spurious undo step. See peel.ts for architecture notes.
  const actionsRef = useRef(actions);
  useLayoutEffect(() => {
    actionsRef.current = actions;
  });

  useEffect(() => {
    return () => {
      const actions = actionsRef.current;
      queueMicrotask(() => {
        actions.adv.layer.peel.discardExchange.execute.noundo();
      });
    };
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

// ─── useGizmoHoverSync ────────────────────────────────────────────────────────

/**
 * Hover-reveal for the selection TransformGizmo box (PS Transform-Selection
 * feel): the handles stay hidden until the pointer enters the selection's
 * bounding box (with a small handle-radius pad), and hide again while ANY
 * gesture interaction is in flight — including the transform drag itself,
 * where the moving pointer would keep re-triggering its own reveal.
 *
 * The gizmo box is pointer-events-none (handles carry their own hit zones),
 * so CSS :hover cannot see it — the reveal is driven by a document
 * pointermove listener projecting the pointer into canvas space, same
 * projection the cursor hooks use.
 */
export function useGizmoHoverSync(
  boxRef: RefObject<HTMLElement | null>,
  isActive: boolean
) {
  const { actions, geometry } = useEditorServices();
  const { state, activeFrame } = useEditorState();

  const frameRef = useRef(activeFrame);
  useLayoutEffect(() => { frameRef.current = activeFrame; });
  const interactingRef = useRef(!!state.interaction.isInteracting);
  useLayoutEffect(() => {
    interactingRef.current = !!state.interaction.isInteracting;
    // Hide immediately when a gesture starts; re-evaluate on release.
    if (boxRef.current) {
      boxRef.current.style.opacity = (!isActive || interactingRef.current) ? '0' : boxRef.current.style.opacity;
    }
  }, [state.interaction.isInteracting, isActive, boxRef]);

  useEffect(() => {
    if (!isActive) return;

    const onPointerMove = (ev: PointerEvent) => {
      const el = boxRef.current;
      if (!el) return;
      const frame = frameRef.current;
      if (!frame || interactingRef.current) {
        el.style.opacity = '0';
        return;
      }

      // Project pointer → canvas-local (same recipe as useClipCursor).
      const container = document.querySelector('.editor-viewport-container');
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const vx = ev.clientX - rect.left;
      const vy = ev.clientY - rect.top;
      const currentCam = actions.fast.latestCamera(frame.id);
      const worldPt = geometry.space.screenToWorld(vx, vy, frame, currentCam);
      const canvasPt = geometry.space.worldToLocal(worldPt.x, worldPt.y, frame);

      const poly = frame.confinement;
      if (!poly) {
        el.style.opacity = '0';
        return;
      }
      // Pad the bbox so the gizmo handles still count as "hovering the
      // selection". The pad must reach BEYOND the box edge: the rotation
      // handle floats 24 screen px above the top edge (plus its 10 px hit
      // zone), so a 24 px pad put the dot outside the reveal zone — moving
      // the pointer onto it faded the gizmo out and the press fell through
      // to the move surface, making the handle impossible to grab.
      // (screen px → local px via camera scale)
      const k = currentCam?.k ?? frame.camera.k;
      const pad = 36 / k;
      const inside =
        canvasPt.x >= poly.rect.x - pad && canvasPt.x <= poly.rect.x + poly.rect.w + pad &&
        canvasPt.y >= poly.rect.y - pad && canvasPt.y <= poly.rect.y + poly.rect.h + pad;
      el.style.opacity = inside ? '1' : '0';
    };

    document.addEventListener('pointermove', onPointerMove, { passive: true });
    const el = boxRef.current;
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      if (el) el.style.opacity = '';
    };
  }, [isActive, actions, geometry, boxRef]);
}

// ─── useClipCursor ─────────────────────────────────────────────────────────────

// ─── Selection hover hit-test helpers ────────────────────────────────────────

/** True when the canvas-local point lies within the axis-aligned rect
 * (inclusive of the boundary). */
function bboxContains(pt: { x: number; y: number }, rect: { x: number; y: number; w: number; h: number } | undefined): boolean {
  if (!rect || rect.w <= 0 || rect.h <= 0) return false;
  return pt.x >= rect.x && pt.x <= rect.x + rect.w && pt.y >= rect.y && pt.y <= rect.y + rect.h;
}

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

      // Classify the entity's drawn shape once per move — this is the
      // cross-tool contract: hit-testing follows what was DRAWN, regardless
      // of which tool happens to be active right now. Interior hover → move;
      // edges belong to the gizmo outline strips, not to this pass.
      const shapeType = geometry.polygon.polygonToShape(poly).type;

      let desired: string | null = null;
      if (shapeType === 'rect' || shapeType === 'circle') {
        if (bboxContains(canvasPt, poly.rect)) desired = 'move';
      } else {
        // Path (lasso / wand / sam / boolean result): point-in-polygon over
        // all rings → move.
        if (geometry.polygon.isPointInPolygon(canvasPt, poly.rings)) desired = 'move';
      }

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
