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
import { asLocalShape } from '@opengpex/editor/core/types';
import { CLIP_OPTIONS_SIGNAL_RE_CANVAS, CLIP_OPTIONS_CMD_RESET_BOX } from '../../options/ClipOptions/protocols';

/**
 * useClipOverlayCommands: Encapsulates UI helper logic and command proxies for the cropping overlay.
 */
export function useClipOverlayCommands() {
  const { state, activeFrame } = useEditorState();
  const { actions } = useEditorServices();
  const resetBox = () => actions.executeCommand(CLIP_OPTIONS_CMD_RESET_BOX);

  const boxRef = useRef<HTMLDivElement>(null);
  const [showError, setShowError] = useState(false);

  const isReCanvas = state.getStateSignal(CLIP_OPTIONS_SIGNAL_RE_CANVAS);
  const isClipActive = state.interaction.interactionMode === 'clip';

  const { imageCropBox, canvasCropBox, canvas: canvasDim } = activeFrame || {
    imageCropBox: asLocalShape({ x: 0, y: 0, w: 0, h: 0 }),
    canvasCropBox: asLocalShape({ x: 0, y: 0, w: 0, h: 0 }),
    canvas: { w: 0, h: 0 }
  };

  const cropShape = isReCanvas ? canvasCropBox : imageCropBox;
  const cropBox = cropShape.rect;
  const cropType = cropShape.type;

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

  const actionsRef = useRef(actions);
  useLayoutEffect(() => {
    actionsRef.current = actions;
  });

  useEffect(() => {
    return () => {
      actionsRef.current.adv.layer.merge.mergeHost.execute();
    };
  }, []);

  return {
    activeFrame,
    cropBox,
    cropType,
    imageCropBox,
    canvasCropBox,
    canvasDim,
    isReCanvas,
    isClipActive,
    dragType: state.interaction.isInteracting ? 'move' : '',
    showError,
    boxRef,
    reset: resetBox // Use the standardized command
  };
}
