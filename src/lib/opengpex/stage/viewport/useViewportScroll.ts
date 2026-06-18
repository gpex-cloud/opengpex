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
    const { deltaX, deltaY, clientX, clientY, ctrlKey, metaKey } = e;
    const container = containerRef.current;
    if (!container) return;

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

    if (ctrlKey || metaKey) {
      // Zoom logic
      const rect = container.getBoundingClientRect();
      const zoomDelta = -deltaY * 0.01;
      const anchor = asViewportPoint({ x: clientX - rect.left, y: clientY - rect.top });
      sessionCamRef.current = currentGeometry.camera.projectZoom(currentCam, zoomDelta, anchor);
    } else {
      // Pan logic
      sessionCamRef.current = currentGeometry.camera.projectPan(currentCam, { x: -deltaX, y: -deltaY });
    }

    // Real-time override fast-track
    txRef.current.override(sessionCamRef.current);

    // --- C. Auto Commit (Virtual onEnd with Debounce) ---
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);

    commitTimerRef.current = setTimeout(() => {
      forceCommit();
    }, 500);

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
