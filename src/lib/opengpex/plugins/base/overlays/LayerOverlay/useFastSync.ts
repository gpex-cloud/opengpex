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

import { useRef } from 'react';
import { useEditorServices } from '@opengpex/editor/core/context';
import { useFastSync } from '@opengpex/editor/core/motion/hooks/navigation';
import { Motion } from '@opengpex/editor/core/motion';
import { Layer } from '@opengpex/editor/core/types';

/** Internal throttle interval for matrix computation (~30Hz) */
const MATRIX_THROTTLE_MS = 1000 / 30; // ~33ms

/**
 * useLayerOverlaySync: Layer outline screen-space synchronization.
 * Responsible for projecting the layer's World Matrix to screen space every frame and directly manipulating DOM.
 *
 * [Interaction Hide] During pan/zoom interaction, hides overlay (opacity: 0) immediately
 * (no throttle delay) and skips expensive matrix computation.
 * [Internal Throttle] Matrix computation is self-throttled to ~30Hz when not interacting,
 * but the interacting check runs every frame for instant hide response.
 */
export function useLayerOverlaySync(
  ref: React.RefObject<HTMLElement | null>,
  labelRef: React.RefObject<HTMLElement | null>,
  layer: Layer,
  isActive: boolean
) {
  const { geometry } = useEditorServices();
  const lastMatrixTimeRef = useRef<number>(0);
  const interactionEndTimeRef = useRef<number>(0);
  const wasInteractingRef = useRef<boolean>(false);
  /** True only while waiting for post-interaction debounced restore */
  const pendingRestoreRef = useRef<boolean>(false);

  // No throttleHz option — runs every frame so interacting hide is instant
  useFastSync(ref, isActive, (v, f, cam) => {
    if (!ref.current) return;

    // [Interaction Hide] Instant — runs every frame, no throttle delay
    // Must also disable CSS transition to prevent 200ms fade-out delay
    if (v.activeState.interacting) {
      wasInteractingRef.current = true;
      pendingRestoreRef.current = true;
      if (ref.current.style.opacity !== '0') {
        ref.current.style.transition = 'none';
        ref.current.style.opacity = '0';
      }
      return;
    }

    // [Debounced Restore] Wait 150ms after interaction ends before showing overlay.
    // This prevents flicker during rapid scroll/pinch bursts and gives the canvas
    // time to settle into its final position.
    // Only fires when recovering from interaction-hide (pendingRestoreRef), NOT when
    // hidden by the canvas-sized check — this prevents infinite show/hide cycling.
    if (wasInteractingRef.current) {
      wasInteractingRef.current = false;
      interactionEndTimeRef.current = performance.now();
    }

    if (pendingRestoreRef.current && ref.current.style.opacity === '0') {
      if (performance.now() - interactionEndTimeRef.current < 150) return;
      pendingRestoreRef.current = false;
      ref.current.style.transition = '';
      ref.current.style.opacity = '';
    }

    // [Canvas-sized Hide] Runs every frame (cheap comparison, no throttle needed).
    // If layer matches canvas dimensions exactly and sits at the origin, the outline
    // overlaps with the canvas border — no visual value, so hide it.
    // Placed before the matrix throttle gate to guarantee instant response and
    // prevent a single visible frame at the old transform position.
    const latestLayer = f.layers.byId[layer.id] || layer;
    if (latestLayer.bounding.w === f.canvas.w && latestLayer.bounding.h === f.canvas.h
        && latestLayer.cx === 0 && latestLayer.cy === 0) {
      if (ref.current.style.opacity !== '0') {
        ref.current.style.opacity = '0';
      }
      return;
    }

    // If layer was previously hidden by canvas-sized check but is no longer
    // canvas-sized (e.g. user resized layer), restore visibility.
    if (ref.current.style.opacity === '0' && !pendingRestoreRef.current) {
      ref.current.style.transition = '';
      ref.current.style.opacity = '';
    }

    // [Internal Throttle] Matrix computation at ~30Hz (skip frames when idle)
    const now = performance.now();
    if (now - lastMatrixTimeRef.current < MATRIX_THROTTLE_MS) return;
    lastMatrixTimeRef.current = now;

    // 1. Execute pure geometric operations
    const worldMatrix = geometry.transform.getLayerWorldMatrix(latestLayer);
    const viewMatrix = geometry.camera.getCameraMatrix(f, cam);
    const screenMatrix = viewMatrix.multiply(worldMatrix);

    // 2. Consider local offset from visibleRect
    const rect = latestLayer.visibleShape?.rect || { x: 0, y: 0, w: latestLayer.bounding.w, h: latestLayer.bounding.h };
    const fragmentMatrix = screenMatrix.multiply(geometry.Matrix.translate(rect.x, rect.y));

    // 3. Decompose and sync to DOM (inline useFastMatrixSync logic for full control)
    const matrix = { ...fragmentMatrix, w: rect.w, h: rect.h };
    const { scaleX, scaleY } = geometry.transform.decomposeMatrix(matrix);

    const pureA = matrix.a / (scaleX || 0.001);
    const pureB = matrix.b / (scaleX || 0.001);
    const pureC = matrix.c / (scaleY || 0.001);
    const pureD = matrix.d / (scaleY || 0.001);

    Motion.set(ref.current, {
      width: (matrix.w || 0) * scaleX,
      height: (matrix.h || 0) * scaleY,
      transform: `matrix(${pureA}, ${pureB}, ${pureC}, ${pureD}, ${matrix.tx}, ${matrix.ty})`,
      overwrite: true
    });

    // Label counter-scaling
    if (labelRef?.current) {
      Motion.set(labelRef.current, {
        scale: 1,
        overwrite: true
      });
    }
  });

  return { sync: () => { } };
}
