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
 * useCameraInit: Viewport camera auto-centering logic
 * Solves DOM measurement latency and initialization race conditions during frame switching.
 */
export function useCameraInit(
  containerRef: React.RefObject<HTMLDivElement | null>,
  frame: Frame,
  state: EditorData,
  actions: EditorActions
) {
  const { geometry } = useEditorServices();
  const isInitializedRef = useRef<string | null>(null);
  const lastInitializedRectRef = useRef<string>('');
  const { safeRect, status } = useLayout();

  useEffect(() => {
    // [Timing Optimization] Core startup logic
    // 1. Determine if this is the "first startup" of the current viewport instance
    const isInitialMount = isInitializedRef.current === null;

    // 2. All alignments must wait for layout STABLE, preventing image jumps or double shrinking due to safeRect changes during sidebar loading
    if (status !== 'STABLE') return;

    // 3. Status check: skip if already initialized for the current frameId and safeRect
    const rectKey = `${safeRect.x}-${safeRect.y}-${safeRect.w}-${safeRect.h}`;
    if (isInitializedRef.current === frame.id && lastInitializedRectRef.current === rectKey) return;

    // 4. Data completeness guard
    if (!containerRef.current || frame.layers.order.length === 0) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    if (containerRect.width === 0 || containerRect.height === 0) return;

    const layoutChanged = lastInitializedRectRef.current !== rectKey;

    // If neither first mount nor layout changed, initialization is unnecessary
    if (!isInitialMount && !layoutChanged) return;

    // [FIX] Calculate relativeOffset directly using container-relative safeRect coordinates.
    // This avoids subtracting screen-relative window offsets (containerRect.left/top) from
    // container-relative coordinates, which caused centering skew when ToolMenu was pinned.
    const relativeOffset = {
      left: Math.max(0, safeRect.x),
      top: Math.max(0, safeRect.y),
      right: Math.max(0, state.ui.viewportDim.w - safeRect.w - safeRect.x),
      bottom: Math.max(0, state.ui.viewportDim.h - safeRect.h - safeRect.y)
    };

    const finalCamera = geometry.camera.getFitCamera(
      { w: containerRect.width, h: containerRect.height },
      frame.canvas,
      {
        padding: 80,
        maxScale: 1,
        offsetLeft: relativeOffset.left,
        offsetTop: relativeOffset.top,
        offsetRight: relativeOffset.right,
        offsetBottom: relativeOffset.bottom
      }
    );

    actions.updateCamera(frame.id, finalCamera);

    // Record initialization flag
    isInitializedRef.current = frame.id;
    lastInitializedRectRef.current = rectKey;
  }, [
    frame.id,
    frame.layers.order.length,
    frame.camera.k,
    frame.canvas,
    status,
    safeRect,
    state.ui.viewportDim,
    actions,
    containerRef,
    geometry.camera
  ]);
}
