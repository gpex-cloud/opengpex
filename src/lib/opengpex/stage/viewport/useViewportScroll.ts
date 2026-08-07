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

'use client';

import { useRef, useCallback, useEffect } from 'react';
import { Frame, CameraState, EditorActions, GeometryService, asViewportPoint } from '@opengpex/editor/core/types';
import { CameraTransaction } from '@opengpex/editor/stage/interaction/CameraTransaction';
import type { ViewportScrollMode } from '@opengpex/editor/core/helpers/preferences/presets';
import { presets } from '@opengpex/editor/core/helpers/preferences';

/**
 * Determine whether the current wheel event should trigger a zoom operation.
 *
 * Legacy: requires modifier keys (Ctrl/Cmd/Alt) to zoom
 * Modern: discrete mouse bare scroll defaults to zoom; Ctrl+scroll reverses to pan
 *         Trackpad behavior is consistent across both modes (pinch=zoom, scroll=pan)
 */
function resolveZoomIntent(
  mode: ViewportScrollMode,
  ctx: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isDiscreteMouse: boolean }
): boolean {
  const { ctrlKey, metaKey, altKey, shiftKey, isDiscreteMouse } = ctx;

  // Alt/Option + scroll: both modes treat as zoom (PS compatibility)
  if (altKey) return true;

  // Trackpad pinch (browser auto-sets ctrlKey=true, and not discrete mouse): both modes treat as zoom
  if ((ctrlKey || metaKey) && !isDiscreteMouse) return true;

  if (mode === 'legacy') {
    // Legacy: only Alt+scroll triggers zoom (PS behavior).
    // Ctrl/Cmd + discrete mouse scroll does NOT zoom — freed for browser/system use.
    return false;
  } else {
    // Modern: discrete mouse bare scroll = zoom (except Shift, which is reserved for H-pan)
    //         Ctrl/Cmd + discrete mouse scroll = pan (reversed)
    if ((ctrlKey || metaKey) && isDiscreteMouse) return false; // Ctrl+scroll = pan
    if (shiftKey) return false; // Shift+scroll = H-pan
    return isDiscreteMouse; // bare scroll = zoom
  }
}

/**
 * useViewportScroll: Dedicated viewport scroll/zoom logic pipeline
 * Employs CameraTransaction to manage fast-track sessions, locking closure state during continuous scrolling to eliminate state sync latency.
 */
export function useViewportScroll(
  containerRef: React.RefObject<HTMLDivElement | null>,
  frame: Frame,
  actions: EditorActions,
  geometry: GeometryService
) {
  // 1. Local accumulator state
  const sessionCamRef = useRef<CameraState | null>(null);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const txRef = useRef<CameraTransaction | null>(null);

  // 2. Use Ref to cache dynamic properties, keeping handleWheel closure reference absolutely stable, eliminating timer destruction and crashes from redraws
  const frameRef = useRef(frame);
  const actionsRef = useRef(actions);
  const geometryRef = useRef(geometry);

  useEffect(() => {
    frameRef.current = frame;
    actionsRef.current = actions;
    geometryRef.current = geometry;
  }, [frame, actions, geometry]);

  /** Force commit current session (used for cleanup and pointerleave) */
  const forceCommit = useCallback(() => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    if (txRef.current) {
      txRef.current.commit();
      txRef.current = null;
    }
    sessionCamRef.current = null;
    commitTimerRef.current = null;
  }, []);

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    let { deltaX, deltaY } = e;
    const { clientX, clientY, ctrlKey, metaKey, altKey, shiftKey } = e;
    const container = containerRef.current;
    if (!container) return;

    // ─── 1. deltaMode normalization (Firefox line mode → pixel equivalent) ───
    // deltaMode 1 = line units (Firefox default); convention: 1 line ≈ 16px
    // deltaMode 2 = page units (rare); approximate as viewport height
    if (e.deltaMode === 1) { deltaX *= 16; deltaY *= 16; }
    if (e.deltaMode === 2) { deltaX *= window.innerHeight; deltaY *= window.innerHeight; }

    // ─── 2. Detect discrete mouse wheel vs continuous trackpad ───
    // Heuristic: Chrome/Edge on Windows sends deltaY = ±100 or ±120 for standard
    // mouse wheels (integer, large magnitude). Trackpads produce small fractional
    // values (e.g. ±0.5~5). Threshold 50 safely separates the two populations.
    const isDiscreteMouse = Math.abs(deltaY) >= 50 && deltaY === Math.round(deltaY);

    const currentFrame = frameRef.current;
    const currentActions = actionsRef.current;
    const currentGeometry = geometryRef.current;

    // --- A. Start Session (Virtual onStart) ---
    if (!txRef.current) {
      const tx = new CameraTransaction(currentActions, currentFrame.id);
      tx.begin();
      txRef.current = tx;
      // Capture baseline camera, all subsequent increments evolve based on it
      sessionCamRef.current = currentActions.fast.latestCamera(currentFrame.id);
    }

    // --- B. Execute Evolution (Virtual onMove) ---
    const currentCam = sessionCamRef.current;
    if (!currentCam) return;

    // ─── 3. Operation group routing ───
    const shouldZoom = resolveZoomIntent(presets.get('VIEWPORT_SCROLL_MODE'), { ctrlKey, metaKey, altKey, shiftKey, isDiscreteMouse });

    if (shouldZoom) {
      // ─── Zoom: clamp to prevent single-event jump being too large ───
      // Without clamping, a Windows mouse wheel (deltaY=100~120) would produce
      // ratio = 1 + 1.0~1.2, causing 100-120% zoom per notch — unusable.
      // Clamp at 0.15 (15% per event) aligns with industry standard editors (10-20% per notch).
      const rect = container.getBoundingClientRect();
      const rawDelta = -deltaY * 0.01;
      const zoomDelta = isDiscreteMouse
        ? Math.sign(rawDelta) * Math.min(Math.abs(rawDelta), 0.15)
        : rawDelta;
      const anchor = asViewportPoint({ x: clientX - rect.left, y: clientY - rect.top });
      sessionCamRef.current = currentGeometry.camera.projectZoom(currentCam, zoomDelta, anchor);
    } else {
      // ─── Pan ───
      // Discrete mouse scale 0.3: reduces 100px delta → 30px per notch (≈ 2 text lines),
      // preventing jarring jumps. Trackpad (continuous) uses 1:1 mapping for natural feel.
      // Shift+scroll: redirect vertical delta to horizontal axis for H-pan (industry convention).
      const panScale = isDiscreteMouse ? 0.3 : 1.0;
      const panX = shiftKey ? -deltaY * panScale : -deltaX * panScale;
      const panY = shiftKey ? 0 : -deltaY * panScale;
      sessionCamRef.current = currentGeometry.camera.projectPan(currentCam, { x: panX, y: panY });
    }

    // Real-time override fast-track
    txRef.current.override(sessionCamRef.current);

    // --- C. Auto Commit (Virtual onEnd with Debounce) ---
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);

    commitTimerRef.current = setTimeout(() => {
      forceCommit();
    }, presets.get('VIEWPORT_CAMERA_COMMIT_DEBOUNCE_MS'));

  }, [containerRef, forceCommit]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMouseLeave = () => {
      if (txRef.current) forceCommit();
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    container.addEventListener('pointerleave', handleMouseLeave);

    return () => {
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('pointerleave', handleMouseLeave);
      
      // Physical destruction or frame-switching defense: if there are uncommitted fast-track increments, force instant commit, never discard
      if (txRef.current) forceCommit();
    };
  }, [containerRef, handleWheel, frame.id, forceCommit]);
}
