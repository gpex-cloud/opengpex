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

import { useState, useRef, useEffect, useLayoutEffect, type RefObject } from 'react';
import { useEditorState, useEditorServices } from '@opengpex/editor/core/context';
import { Motion } from '@opengpex/editor/core/motion';
import { asLocalShape, LocalPolygon } from '@opengpex/editor/core/types';
import { polygonToShape } from '@opengpex/editor/core/helpers/path2d';
import { getRegularClipShape } from '@opengpex/editor/core/helpers/selection';
import {
  ClipOptionsAPI,
  CLIP_TOOL_STRATEGIES,
  ClipTool,
} from '../../options/ClipOptions/protocols';
import { CLIP_PATHELLIPSE_CURSOR } from '@opengpex/editor/icons';

/**
 * useClipOverlayCommands: Encapsulates UI helper logic and command proxies
 * for the clipping overlay.
 */
export function useClipOverlayCommands() {
  const { state, activeFrame } = useEditorState();
  const { actions } = useEditorServices();
  const resetBox = () => actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);

  const boxRef = useRef<HTMLDivElement>(null);
  const [showError, setShowError] = useState(false);

  const isReCanvas = state.getStateSignal(ClipOptionsAPI.signals.reCanvas);
  const isClipActive = state.interaction.interactionMode === 'clip';

  // Active clip / selection tool — read from per-frame field.
  const rawTool = (activeFrame?.latestClipTool as ClipTool) || 'rect';

  // Re-Canvas pins tool to 'rect' (canvas resize is always rectangular).
  const clipTool: ClipTool = isReCanvas ? 'rect' : (CLIP_TOOL_STRATEGIES[rawTool] ? rawTool : 'rect');
  const family = CLIP_TOOL_STRATEGIES[clipTool].family;
  const isRegularTool = family === 'regular';
  const isIrregularTool = family === 'irregular';

  const { clipBoxes, canvasClipBox, canvas: canvasDim } = activeFrame || {
    clipBoxes: {} as Record<string, LocalPolygon>,
    canvasClipBox: asLocalShape({ x: 0, y: 0, w: 0, h: 0 }),
    canvas: { w: 0, h: 0 }
  };

  const imageClipBox = getRegularClipShape({ clipBoxes });
  const clipShape = isReCanvas ? canvasClipBox : (imageClipBox ? polygonToShape(imageClipBox) : asLocalShape({ x: 0, y: 0, w: 0, h: 0 }));
  const clipBox = clipShape.rect;
  const clipType = clipShape.type;

  // Error pulse animation
  const lastPulse = useRef(state.interaction.selectionErrorPulse);
  useEffect(() => {
    if (state.interaction.selectionErrorPulse && state.interaction.selectionErrorPulse !== lastPulse.current) {
      lastPulse.current = state.interaction.selectionErrorPulse;
      setShowError(true);
      if (boxRef.current) {
        Motion.to(boxRef.current, {
          borderColor: '#ef4444',
          duration: 0.15, repeat: 3, yoyo: true,
          onComplete: () => { Motion.set(boxRef.current, { borderColor: '#ffffff' }); }
        });
      }
      setTimeout(() => setShowError(false), 1000);
    }
  }, [state.interaction.selectionErrorPulse]);

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
    isIrregularTool,
    dragType: state.interaction.isInteracting ? 'move' : '',
    showError,
    boxRef,
    reset: resetBox
  };
}

// ─── useClipCursor ─────────────────────────────────────────────────────────────

/**
 * useClipCursor: Sets per-tool custom cursor when clip mode is active.
 *
 * For irregular tools (lasso/wand), dynamically switches between the tool's
 * default cursor and 'move' cursor when the pointer hovers inside an existing
 * polygon selection. This gives the user visual feedback that they can drag
 * to move (or Meta+drag to peel) the selection.
 */
export function useClipCursor(
  isClipActive: boolean,
  clipTool: ClipTool,
  boxRef?: RefObject<HTMLElement | null>,
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

  // Read AA state for dynamic cursor switching (ellipse/pathellipse: dashed cursor when AA off)
  const clipBox_AA = (activeFrame?.clipBoxes?.[clipTool] as LocalPolygon | undefined)?.antiAliased ?? true;

  useEffect(() => {
    if (isClipActive) {
      // For ellipse-family tools: switch to dashed cursor when AA is off
      const isEllipseFamily = clipTool === 'ellipse' || clipTool === 'pathellipse';
      const toolCursor = isEllipseFamily && !clipBox_AA
        ? CLIP_PATHELLIPSE_CURSOR
        : CLIP_TOOL_STRATEGIES[clipTool].cursor;
      actions.fast.setCursor(toolCursor);
    } else {
      actions.fast.setCursor(null);
    }
  }, [isClipActive, clipTool, clipBox_AA, actions]);

  // ─── Polygon hover cursor for irregular tools ──────────────────────────
  useEffect(() => {
    const strategy = CLIP_TOOL_STRATEGIES[clipTool];
    if (!isClipActive || strategy.family !== 'irregular') return;

    const toolCursor = strategy.cursor;
    let currentCursor = toolCursor;

    const onPointerMove = (ev: PointerEvent) => {
      const frame = frameRef.current;
      if (!frame) return;

      // Get polygon from clipBoxes
      const poly = frame.clipBoxes?.[clipTool] as LocalPolygon | undefined;
      if (!poly || !poly.rings || poly.rings.length === 0) {
        if (currentCursor !== toolCursor) {
          currentCursor = toolCursor;
          actions.fast.setCursor(toolCursor);
        }
        return;
      }

      // Project pointer position to canvas-local coordinates
      const container = document.querySelector('.editor-viewport-container');
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const vx = ev.clientX - rect.left;
      const vy = ev.clientY - rect.top;

      const currentCam = actions.fast.latestCamera(frame.id);
      const worldPt = geometry.space.screenToWorld(vx, vy, frame, currentCam);
      const canvasPt = geometry.space.worldToLocal(worldPt.x, worldPt.y, frame);

      // Point-in-polygon hit test
      const inside = geometry.polygon.isPointInPolygon(canvasPt, poly.rings);
      const desired = inside ? 'move' : toolCursor;

      if (desired !== currentCursor) {
        currentCursor = desired;
        actions.fast.setCursor(desired);
      }
    };

    document.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      // Restore tool cursor on cleanup
      if (currentCursor !== toolCursor) {
        actions.fast.setCursor(toolCursor);
      }
    };
  }, [isClipActive, clipTool, actions, geometry]);

  // ─── Edge proximity cursor for regular tools + Re-Canvas ───────────────
  // Dynamically switches cursor to ns-resize / ew-resize when the pointer
  // hovers near a selection edge. This provides visual feedback that the
  // edge is draggable (edge hit detection without fixed-position handles).
  // Also fires in Re-Canvas mode (which is always rectangular).
  useEffect(() => {
    const strategy = CLIP_TOOL_STRATEGIES[clipTool];
    // Activate when: (clip mode + regular tool) OR Re-Canvas mode
    const isActive = (isClipActive && strategy.family === 'regular') || !!isReCanvas;
    if (!isActive) return;

    const EDGE_THRESHOLD_PX = 6; // screen pixels
    // Re-Canvas uses plain 'crosshair' (no tool subscript indicator) because
    // it's a canvas-resize modal, not a selection tool. The subscript would
    // misleadingly suggest the rect selection tool is active.
    const toolCursor = isReCanvas ? 'crosshair' : strategy.cursor;
    let currentCursor = toolCursor;

    // Restore tool cursor on effect (re-)setup. This is critical when the
    // effect re-runs due to isReCanvas toggling: cleanup sets cursor to null,
    // but the tool-cursor useEffect (deps=[isClipActive, clipTool]) won't
    // re-fire if those deps didn't change. We must actively restore here.
    actions.fast.setCursor(toolCursor);

    const onPointerMove = (ev: PointerEvent) => {
      // Skip cursor updates during active interaction (resize/move/create drag).
      // The box dimensions change while dragging, causing distance-to-edge to
      // oscillate → cursor flickers between resize/tool cursors.
      if (isInteractingRef.current) return;

      const frame = frameRef.current;
      if (!frame) return;

      // Get the bounding rect: Re-Canvas reads canvasClipBox, regular reads clipBoxes
      const selRect = isReCanvas
        ? frame.canvasClipBox?.rect
        : getRegularClipShape(frame)?.rect;

      if (!selRect || selRect.w <= 0 || selRect.h <= 0) {
        if (currentCursor !== toolCursor) {
          currentCursor = toolCursor;
          actions.fast.setCursor(toolCursor);
        }
        return;
      }

      // Project pointer position to canvas-local coordinates
      const container = document.querySelector('.editor-viewport-container');
      if (!container) return;
      const domRect = container.getBoundingClientRect();
      const vx = ev.clientX - domRect.left;
      const vy = ev.clientY - domRect.top;

      const currentCam = actions.fast.latestCamera(frame.id);
      const worldPt = geometry.space.screenToWorld(vx, vy, frame, currentCam);
      const canvasPt = geometry.space.worldToLocal(worldPt.x, worldPt.y, frame);

      // Convert threshold from screen pixels to canvas-local pixels
      const k = currentCam?.k ?? frame.camera.k;
      const T = EDGE_THRESHOLD_PX / k;

      const px = canvasPt.x;
      const py = canvasPt.y;

      const isEllipse = clipTool === 'ellipse' || clipTool === 'pathellipse';

      // Determine desired cursor
      let desired = toolCursor;

      if (isEllipse) {
        // ─── Ellipse: distance to ellipse arc ─────────────────────────
        const cx = selRect.x + selRect.w / 2;
        const cy = selRect.y + selRect.h / 2;
        const rx = selRect.w / 2;
        const ry = selRect.h / 2;

        const nx = (px - cx) / rx;
        const ny = (py - cy) / ry;
        const r = Math.sqrt(nx * nx + ny * ny);
        const avgRadius = (rx + ry) / 2;
        const distToEllipse = Math.abs(r - 1) * avgRadius;

        if (distToEllipse <= T) {
          // Quadrant-based direction: |cos| > |sin| → horizontal, else vertical
          const dist = Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy)) || 1;
          const cosA = Math.abs((px - cx) / dist);
          const sinA = Math.abs((py - cy) / dist);
          desired = cosA > sinA ? 'ew-resize' : 'ns-resize';
        }
      } else {
        // ─── Rectangle: distance to bounding rect edges ───────────────
        const dTop = Math.abs(py - selRect.y);
        const dBottom = Math.abs(py - (selRect.y + selRect.h));
        const dLeft = Math.abs(px - selRect.x);
        const dRight = Math.abs(px - (selRect.x + selRect.w));

        const inHRange = px >= selRect.x - T && px <= selRect.x + selRect.w + T;
        const inVRange = py >= selRect.y - T && py <= selRect.y + selRect.h + T;

        if (dTop <= T && inHRange) desired = 'ns-resize';
        else if (dBottom <= T && inHRange) desired = 'ns-resize';
        else if (dLeft <= T && inVRange) desired = 'ew-resize';
        else if (dRight <= T && inVRange) desired = 'ew-resize';
      }

      if (desired !== currentCursor) {
        currentCursor = desired;
        actions.fast.setCursor(desired);
        // Override box div's cursor to match edge cursor (the box has static
        // `cursor-move` which otherwise wins over the viewport-level cursor).
        if (boxRef?.current) {
          boxRef.current.style.cursor = desired === toolCursor ? 'move' : desired;
        }
      }
    };

    const boxEl = boxRef?.current;
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      // Reset to null — let the mode-level cursor (pan=grab, clip=crosshair)
      // be re-applied by the first useEffect when dependencies change.
      actions.fast.setCursor(null);
      if (boxEl) {
        boxEl.style.cursor = '';
      }
    };
  }, [isClipActive, isReCanvas, clipTool, actions, geometry, boxRef]);

  useEffect(() => {
    return () => {
      actions.fast.setCursor(null);
    };
  }, [actions]);
}
