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
import { useLayout } from '@opengpex/editor/workspace/LayoutContext';

/**
 * useCameraInit: Viewport camera layout-change reaction.
 *
 * Handles one behavior:
 *
 *  **Pan-only compensation** — fired when the same frame stays active
 *  but `safeRect` shifts (drawer panel opened/closed, ToolMenu pin toggled,
 *  window resized, etc.). Re-fitting at that moment would discard the
 *  user's manual zoom/pan — terrible UX when editing pixel-level details
 *  at high zoom. Instead we translate the camera by `Δcenter(safeRect)` so
 *  that whatever world point sat at the center of the OLD safeRect remains
 *  at the center of the NEW safeRect; zoom is preserved exactly.
 *
 * NOTE: Auto-fit on first mount has been intentionally removed.
 * All frame creation paths (singleImage, multiSubImage, create, branch, etc.)
 * already compute and store the correct initial camera via getFitCamera before
 * calling addFrame. On page refresh, the camera is restored from IndexedDB via
 * HYDRATE. There is no scenario where the Viewport mounts with an
 * uninitialized camera, so re-fitting on mount only discards the user's
 * previously saved zoom/pan state.
 *
 * The math: in the camera matrix
 *     Screen = Translate(cam.x, cam.y) · Scale(cam.k) · Translate(W/2, H/2)
 * the screen position of any world point is a pure function of `cam.{x,y}`
 * up to a constant. Hence shifting `cam.{x,y}` by `(Δcx, Δcy)` shifts the
 * entire image on screen by exactly that amount — which is precisely what
 * "keep the focal point centered in the new safe area" requires.
 *
 * Gates on `status === 'STABLE'` to avoid acting on transient
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

  // Tracks the safeRect center we last observed, for pan-only compensation.
  // Null = not yet initialized (first STABLE render for this frame).
  const lastSafeCenterRef = useRef<{ cx: number; cy: number } | null>(null);
  // Tracks the frame.id we last observed, to reset center tracking on frame switch.
  const lastFrameIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (status !== 'STABLE') return;
    if (!containerRef.current || frame.layers.order.length === 0) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    if (containerRect.width === 0 || containerRect.height === 0) return;

    const newCx = safeRect.x + safeRect.w / 2;
    const newCy = safeRect.y + safeRect.h / 2;

    const isFrameSwitched = lastFrameIdRef.current !== null && lastFrameIdRef.current !== frame.id;

    // On frame switch or first stable render for this frame: just record the
    // current safeRect center without touching the camera. The camera is already
    // correct (set by the frame creation command or restored from storage).
    if (lastSafeCenterRef.current === null || isFrameSwitched) {
      lastSafeCenterRef.current = { cx: newCx, cy: newCy };
      lastFrameIdRef.current = frame.id;
      return;
    }

    // ── Pan-only compensation ──────────────────────────────────────────────
    // safeRect shifted (panel opened/closed, window resized, etc.) while the
    // same frame is active. Translate camera by Δcenter so the focal point
    // stays visually centered in the new safe area.
    const { cx: oldCx, cy: oldCy } = lastSafeCenterRef.current;
    const dcx = newCx - oldCx;
    const dcy = newCy - oldCy;

    if (Math.abs(dcx) < 0.5 && Math.abs(dcy) < 0.5) {
      // No meaningful shift — skip to avoid spurious dispatches.
      return;
    }

    const currentCam = frame.camera;
    actions.updateCamera(frame.id, {
      x: currentCam.x + dcx,
      y: currentCam.y + dcy,
      k: currentCam.k,
    });

    // Update reference for the next layout change.
    lastSafeCenterRef.current = { cx: newCx, cy: newCy };
    lastFrameIdRef.current = frame.id;
  }, [
    frame.id,
    frame.layers.order.length,
    frame.camera,
    safeRect.x,
    safeRect.y,
    safeRect.w,
    safeRect.h,
    status,
    state.ui.viewportDim.w,
    state.ui.viewportDim.h,
    actions,
    containerRef,
    geometry.camera,
  ]);
}
