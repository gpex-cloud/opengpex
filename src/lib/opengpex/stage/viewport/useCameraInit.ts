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

import React, { useRef, useEffect } from 'react';
import { useEditorServices } from '@opengpex/editor/core/context';
import { Frame, EditorData, EditorActions } from '@opengpex/editor/core/types';
import { VIEWPORT_FIT_PADDING } from '@opengpex/editor/core/helpers/presets';
import { useLayout } from '@opengpex/editor/workspace/LayoutContext';

/**
 * useCameraInit: Viewport camera auto-centering & layout-change reaction.
 *
 * Two distinct behaviors keyed off the current frame and `safeRect`:
 *
 *  A. **Auto-fit (zoom + pan)** — fired only when:
 *       - the hook mounts for the first time, OR
 *       - the active frame.id has changed (cross-frame switch).
 *     In both cases the user has no expectation of preserving zoom, so we
 *     compute a fresh `getFitCamera` to center the canvas inside the safeRect.
 *
 *  B. **Pan-only compensation** — fired when the same frame stays active
 *     but `safeRect` shifts (drawer panel opened/closed, ToolMenu pin toggled,
 *     window resized, etc.). Re-fitting at that moment would discard the
 *     user's manual zoom/pan — terrible UX when editing pixel-level details
 *     at high zoom. Instead we translate the camera by `Δcenter(safeRect)` so
 *     that whatever world point sat at the center of the OLD safeRect remains
 *     at the center of the NEW safeRect; zoom is preserved exactly.
 *
 * The math: in the camera matrix
 *     Screen = Translate(cam.x, cam.y) · Scale(cam.k) · Translate(W/2, H/2)
 * the screen position of any world point is a pure function of `cam.{x,y}`
 * up to a constant. Hence shifting `cam.{x,y}` by `(Δcx, Δcy)` shifts the
 * entire image on screen by exactly that amount — which is precisely what
 * "keep the focal point centered in the new safe area" requires.
 *
 * Both branches gate on `status === 'STABLE'` to avoid acting on transient
 * intermediate measurements during MEASURING.
 */
export function useCameraInit(
  containerRef: React.RefObject<HTMLDivElement | null>,
  frame: Frame,
  state: EditorData,
  actions: EditorActions
) {
  const { geometry } = useEditorServices();
  const { safeRect, status } = useLayout();

  // Tracks the frame.id we last "centered" on (auto-fit). Null = never yet.
  const initializedFrameIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (status !== 'STABLE') return;
    if (!containerRef.current || frame.layers.order.length === 0) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    if (containerRect.width === 0 || containerRect.height === 0) return;

    const isFirstMount = initializedFrameIdRef.current === null;
    const isFrameSwitched = !isFirstMount && initializedFrameIdRef.current !== frame.id;

    // Nothing to do.
    if (!isFirstMount && !isFrameSwitched) return;

    // ── Branch A: Auto-fit ──────────────────────────────────────────────
    // Compute insets directly from container-relative safeRect coords
    // (avoids subtracting screen-relative offsets that misalign when the
    // ToolMenu is pinned).
    const relativeOffset = {
      left: Math.max(0, safeRect.x),
      top: Math.max(0, safeRect.y),
      right: Math.max(0, state.ui.viewportDim.w - safeRect.w - safeRect.x),
      bottom: Math.max(0, state.ui.viewportDim.h - safeRect.h - safeRect.y),
    };

    const finalCamera = geometry.camera.getFitCamera(
      { w: containerRect.width, h: containerRect.height },
      frame.canvas,
      {
        padding: VIEWPORT_FIT_PADDING,
        maxScale: 1,
        offsetLeft: relativeOffset.left,
        offsetTop: relativeOffset.top,
        offsetRight: relativeOffset.right,
        offsetBottom: relativeOffset.bottom,
      },
    );

    actions.updateCamera(frame.id, finalCamera);

    // Always remember where we are now so the *next* layout change can
    // compute its own delta correctly.
    initializedFrameIdRef.current = frame.id;
  }, [
    frame.id,
    frame.layers.order.length,
    frame.canvas,
    status,
    safeRect.x,
    safeRect.y,
    safeRect.w,
    safeRect.h,
    state.ui.viewportDim.w,
    state.ui.viewportDim.h,
    actions,
    containerRef,
    geometry.camera,
  ]);
}
