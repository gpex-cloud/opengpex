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

import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { useEditorState, useEditorServices } from '@opengpex/editor/core/context';
import { Motion } from '@opengpex/editor/core/motion';
import { asLocalShape, LocalShape, LocalPolygon } from '@opengpex/editor/core/types';
import { getRegularClipShape } from '@opengpex/editor/core/helpers/selection';
import {
  ClipOptionsAPI,
  CLIP_TOOL_STRATEGIES,
  ClipTool,
} from '../../options/ClipOptions/protocols';

/**
 * useClipOverlayCommands: Encapsulates UI helper logic and command proxies
 * for the cropping overlay.
 */
export function useClipOverlayCommands() {
  const { state, activeFrame } = useEditorState();
  const { actions } = useEditorServices();
  const resetBox = () => actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);

  const boxRef = useRef<HTMLDivElement>(null);
  const [showError, setShowError] = useState(false);

  const isReCanvas = state.getStateSignal(ClipOptionsAPI.signals.reCanvas);
  const isClipActive = state.interaction.interactionMode === 'clip';

  // Active crop / selection tool — read from per-frame field.
  const rawTool = (activeFrame?.latestClipTool as ClipTool) || 'rect';

  // Re-Canvas pins tool to 'rect' (canvas resize is always rectangular).
  const cropTool: ClipTool = isReCanvas ? 'rect' : (CLIP_TOOL_STRATEGIES[rawTool] ? rawTool : 'rect');
  const family = CLIP_TOOL_STRATEGIES[cropTool].family;
  const isRegularTool = family === 'regular';
  const isIrregularTool = family === 'irregular';

  const { clipBoxes, canvasCropBox, canvas: canvasDim } = activeFrame || {
    clipBoxes: {} as Record<string, LocalShape | LocalPolygon>,
    canvasCropBox: asLocalShape({ x: 0, y: 0, w: 0, h: 0 }),
    canvas: { w: 0, h: 0 }
  };

  const imageCropBox = getRegularClipShape({ clipBoxes: clipBoxes as Record<string, LocalShape | LocalPolygon> });
  const cropShape = isReCanvas ? canvasCropBox : (imageCropBox || asLocalShape({ x: 0, y: 0, w: 0, h: 0 }));
  const cropBox = cropShape.rect;
  const cropType = cropShape.type;

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
    cropBox,
    cropType,
    imageCropBox: imageCropBox || asLocalShape({ x: 0, y: 0, w: 0, h: 0 }),
    canvasCropBox,
    canvasDim,
    isReCanvas,
    isClipActive,
    cropTool,
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
export function useClipCursor(isClipActive: boolean, cropTool: ClipTool) {
  const { actions, geometry } = useEditorServices();
  const { activeFrame } = useEditorState();

  // Ref to keep latest frame accessible in the pointermove closure without
  // re-registering the listener on every frame change.
  const frameRef = useRef(activeFrame);
  useLayoutEffect(() => { frameRef.current = activeFrame; });

  useEffect(() => {
    if (isClipActive) {
      const toolCursor = CLIP_TOOL_STRATEGIES[cropTool].cursor;
      actions.fast.setCursor(toolCursor);
    } else {
      actions.fast.setCursor(null);
    }
  }, [isClipActive, cropTool, actions]);

  // ─── Polygon hover cursor for irregular tools ──────────────────────────
  useEffect(() => {
    const strategy = CLIP_TOOL_STRATEGIES[cropTool];
    if (!isClipActive || strategy.family !== 'irregular') return;

    const toolCursor = strategy.cursor;
    let currentCursor = toolCursor;

    const onPointerMove = (ev: PointerEvent) => {
      const frame = frameRef.current;
      if (!frame) return;

      // Get polygon from clipBoxes
      const poly = frame.clipBoxes?.[cropTool] as LocalPolygon | undefined;
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
  }, [isClipActive, cropTool, actions, geometry]);

  useEffect(() => {
    return () => {
      actions.fast.setCursor(null);
    };
  }, [actions]);
}
