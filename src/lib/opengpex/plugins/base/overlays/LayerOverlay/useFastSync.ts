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
import { useEditorServices, useEditorState } from '@opengpex/editor/core/context';
import { useFastSync } from '@opengpex/editor/core/state/volatile';
import { useTicker } from '@opengpex/editor/core/motion/hooks/animation';
import { Motion } from '@opengpex/editor/core/motion';
import { Layer } from '@opengpex/editor/core/types';

/** Internal throttle interval for matrix computation (~30Hz) */
const MATRIX_THROTTLE_MS = 1000 / 30; // ~33ms

/** Grace period after a camera gesture before the overlay fades back in. */
const CAMERA_RESTORE_DELAY_MS = 150;

/**
 * useLayerOverlayCameraHide: HOST-level camera-move auto-hide.
 *
 * LayerOverlay owns this policy — contributors never implement it. While the
 * camera is moving (pan/zoom/programmatic), every outline is anchored to a
 * stale camera, so the whole container fades out; 150ms after the gesture
 * ends it fades back in. The discriminator compares the fast-track camera
 * draft (written every frame by a camera transaction) against the committed
 * React-state camera. Reading the committed camera — not the merged frame
 * the per-item sync callbacks receive — is what makes this reliable: the
 * merged frame already contains the draft camera, so a compare against it
 * is tautologically false.
 *
 * Layer-edit gestures (move/resize/rotate) never open a camera draft, so
 * this stays inert while the user manipulates a layer — outlines are the
 * manipulation affordance and must not vanish mid-drag.
 */
export function useLayerOverlayCameraHide(
  ref: React.RefObject<HTMLElement | null>
) {
  const { volatileRef } = useEditorServices();
  const { state } = useEditorState();
  const committedFrame = state.activeFrameId ? state.frames.byId[state.activeFrameId] : undefined;
  const wasMovingRef = useRef(false);
  const interactionEndTimeRef = useRef(0);

  useTicker(() => {
    const el = ref.current;
    if (!el || !committedFrame) return;

    const bufferedCam = volatileRef.current.buffered.frames[committedFrame.id]?.camera;
    const moving = !!bufferedCam && (
      bufferedCam.x !== committedFrame.camera.x
      || bufferedCam.y !== committedFrame.camera.y
      || bufferedCam.k !== committedFrame.camera.k
    );

    if (moving) {
      wasMovingRef.current = true;
      el.dataset.cameraHidden = 'true';
      if (el.style.opacity !== '0') {
        // Bypass the CSS fade so the stale outlines vanish on the same frame
        // the camera starts diverging.
        el.style.transition = 'none';
        el.style.opacity = '0';
      }
      return;
    }

    if (wasMovingRef.current) {
      wasMovingRef.current = false;
      interactionEndTimeRef.current = performance.now();
    }

    // Debounced restore: absorb rapid scroll/pinch bursts without flicker.
    if (el.dataset.cameraHidden === 'true'
        && performance.now() - interactionEndTimeRef.current >= CAMERA_RESTORE_DELAY_MS) {
      delete el.dataset.cameraHidden;
      el.style.transition = 'opacity 0.2s ease-out';
      el.style.opacity = '';
    }
  });
}

/**
 * useLayerOverlaySync: Layer outline screen-space synchronization.
 * Responsible for projecting the layer's World Matrix to screen space every frame and directly manipulating DOM.
 *
 * [Per-item scope] This hook deliberately does NOT own the camera-move hide —
 * that policy lives once at the container level in useLayerOverlayCameraHide.
 * What remains here is the per-layer decision (canvas-sized hide) plus the
 * matrix sync itself.
 */
export function useLayerOverlaySync(
  ref: React.RefObject<HTMLElement | null>,
  labelRef: React.RefObject<HTMLElement | null>,
  layer: Layer,
  isActive: boolean
) {
  const { geometry } = useEditorServices();
  const lastMatrixTimeRef = useRef<number>(0);
  /** True while this item is hidden by the canvas-sized check. */
  const canvasHiddenRef = useRef<boolean>(false);

  // No throttleHz option — runs every frame
  useFastSync(ref, isActive, (v, f) => {
    if (!ref.current) return;

    // [Canvas-sized Hide] Runs every frame (cheap comparison, no throttle needed).
    // If layer matches canvas dimensions exactly and sits at the origin, the outline
    // overlaps with the canvas border — no visual value, so hide it.
    // Placed before the matrix throttle gate to guarantee instant response and
    // prevent a single visible frame at the old transform position.
    const latestLayer = f.layers.byId[layer.id] || layer;
    if (latestLayer.bounding.w === f.canvas.w && latestLayer.bounding.h === f.canvas.h
        && latestLayer.cx === 0 && latestLayer.cy === 0) {
      canvasHiddenRef.current = true;
      if (ref.current.style.opacity !== '0') {
        ref.current.style.opacity = '0';
      }
      return;
    }

    // If layer was previously hidden by canvas-sized check but is no longer
    // canvas-sized (e.g. user resized layer), restore visibility.
    if (canvasHiddenRef.current && ref.current.style.opacity === '0') {
      canvasHiddenRef.current = false;
      ref.current.style.transition = '';
      ref.current.style.opacity = '';
    }

    // [Internal Throttle] Matrix computation at ~30Hz (skip frames when idle)
    const now = performance.now();
    if (now - lastMatrixTimeRef.current < MATRIX_THROTTLE_MS) return;
    lastMatrixTimeRef.current = now;

    // 1. Execute pure geometric operations
    const worldMatrix = geometry.transform.getLayerWorldMatrix(latestLayer);
    const viewMatrix = geometry.camera.getCameraMatrix(f, f.camera);
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

