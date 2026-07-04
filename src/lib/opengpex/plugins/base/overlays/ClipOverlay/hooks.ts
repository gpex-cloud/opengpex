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
  CROP_TOOL_STRATEGIES,
  CropTool,
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
  const rawTool = (activeFrame?.latestClipTool as CropTool) || 'rect';

  // Re-Canvas pins tool to 'rect' (canvas resize is always rectangular).
  const cropTool: CropTool = isReCanvas ? 'rect' : (CROP_TOOL_STRATEGIES[rawTool] ? rawTool : 'rect');
  const family = CROP_TOOL_STRATEGIES[cropTool].family;
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
 */
export function useClipCursor(isClipActive: boolean, cropTool: CropTool) {
  const { actions } = useEditorServices();

  useEffect(() => {
    if (isClipActive) {
      const toolCursor = CROP_TOOL_STRATEGIES[cropTool].cursor;
      actions.fast.setCursor(toolCursor);
    } else {
      actions.fast.setCursor(null);
    }
  }, [isClipActive, cropTool, actions]);

  useEffect(() => {
    return () => {
      actions.fast.setCursor(null);
    };
  }, [actions]);
}
