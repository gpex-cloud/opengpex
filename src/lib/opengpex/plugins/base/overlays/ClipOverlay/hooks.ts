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
import { asLocalShape, isPolygon, LocalShape, LocalPolygon } from '@opengpex/editor/core/types';
import { getRegularClipShape } from '@opengpex/editor/core/helpers/selection';
import {
  CLIP_OPTIONS_SIGNAL_RE_CANVAS,
  CLIP_OPTIONS_CMD_RESET_BOX,
  CROP_TOOL_STRATEGIES,
  CropTool,
} from '../../options/ClipOptions/protocols';

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

  // Active crop / selection tool — read from per-frame field.
  const rawTool = (activeFrame?.latestClipTool as CropTool) || 'rect';
  // ─── Re-Canvas vs Clip orthogonality (2026-06-23 fix) ───────────────────
  // Re-Canvas owns its own visual chrome: a rose-tinted, draggable rect on
  // `canvasCropBox`. It does *not* care about the user's last-selected crop
  // tool (lasso / wand / ellipse) — those are clip-mode concerns. So when
  // Re-Canvas is active we present the tool as a synthetic `'rect'` to the
  // rest of the overlay code path:
  //   • family derivation → always 'regular' → useRegularCropSync's isActive
  //     becomes true → the canvas box becomes draggable;
  //   • polyGroup / polyPath fast-track stays paused;
  //   • `useFastMarchingAntsSync`'s `resetKey` is the synthetic tool (always
  //     'rect' here), so re-entering / re-leaving Re-Canvas does not bleed
  //     stale lasso paths into the canvas channel.
  // We deliberately *do not* mutate `SIGNAL_CROP_TOOL` itself — when the user
  // closes Re-Canvas the original tool returns automatically (it's still the
  // raw signal value). This is the only place where the synthetic projection
  // is needed; all the other consumers (Options bar, ClipOverlay handlers)
  // already check `isReCanvas` explicitly before deciding what to do.
  const cropTool: CropTool = isReCanvas ? 'rect' : rawTool;
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
      // Defer to next microtask so React can finish the unmount commit + paint
      // before kicking off the merge. Mirrors the latency optimisation in
      // ClipOptions::exitClipMode (the centralised exit path); both routes are
      // idempotent thanks to mergeHost's dirty short-circuit, so the duplicate
      // call across the two cleanup paths is safe.
      const actions = actionsRef.current;
      queueMicrotask(() => {
        actions.adv.layer.merge.mergeHost.execute();
      });
    };
  }, []);

  // Pre-PR-6-3: per-tool slot lookup. We only consider the slot that belongs
  // to the *currently active* irregular tool — other slots may still hold
  // stale polygons (preserved on tool switch so the user can come back to
  // them) but are not "the active selection" from the user's POV. The Options
  // pane's "Apply" / "Clear" buttons read this flag to decide whether to show
  // the irregular-mode CTA chrome.
  const hasIrregularBox = isIrregularTool
    ? !!(activeFrame?.clipBoxes[cropTool] && isPolygon(activeFrame.clipBoxes[cropTool]!))
    : false;


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
    hasIrregularBox,
    dragType: state.interaction.isInteracting ? 'move' : '',
    showError,
    boxRef,
    reset: resetBox // Use the standardized command
  };
}
