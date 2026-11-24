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
import { straightenPreviewPose } from '@opengpex/editor/core/state/volatile/straighten';
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

    // 1. Execute pure geometric operations. A live canvas-straighten drag
    // rides the volatile transient: fold the preview pose in here so the
    // outline tracks the GPU preview pixels exactly (the same expressions
    // the render engine's pose-override seam applies).
    const straightenPose = straightenPreviewPose(v.transient, latestLayer, f.canvas);
    const worldMatrix = geometry.transform.getLayerWorldMatrix(latestLayer, straightenPose);
    const viewMatrix = geometry.camera.getCameraMatrix(f, f.camera);
    const screenMatrix = viewMatrix.multiply(worldMatrix);

    // 2. Consider local offset from visibleRect
    const rect = latestLayer.visibleShape?.rect || { x: 0, y: 0, w: latestLayer.bounding.w, h: latestLayer.bounding.h };
    const fragmentMatrix = screenMatrix.multiply(geometry.Matrix.translate(rect.x, rect.y));

    // 3. Upright outline protocol: strip the rotation component from the
    // fragment matrix and replace the box with the rotated rect's screen
    // AABB. Outlines are passive extent indicators, not manipulation
    // affordances — an upright box reads the footprint at a glance while a
    // tilted box forces the eye to re-orient per layer. Translation, scale
    // and flip all survive (the linear part is consumed as-is); only the net
    // rotation is cancelled, so mirrored and non-uniformly scaled layers keep
    // deforming the box exactly as their rendered pixels deform.
    const matrix = { ...fragmentMatrix, w: rect.w, h: rect.h };
    const a = matrix.a || 0, b = matrix.b || 0, c = matrix.c || 0, d = matrix.d || 0;
    const w = matrix.w || 0, h = matrix.h || 0;
    // The four corners of the transformed rect in screen space: the origin
    // (matrix tx/ty already includes the rect-local translate), plus the two
    // edge vectors (first matrix column × w, second × h).
    const x0 = matrix.tx, y0 = matrix.ty;
    const x1 = x0 + a * w, y1 = y0 + b * w;
    const x2 = x0 + c * h, y2 = y0 + d * h;
    const x3 = x1 + c * h, y3 = y1 + d * h;
    const minX = Math.min(x0, x1, x2, x3);
    const minY = Math.min(y0, y1, y2, y3);

    Motion.set(ref.current, {
      width: Math.max(x0, x1, x2, x3) - minX,
      height: Math.max(y0, y1, y2, y3) - minY,
      transform: `matrix(1, 0, 0, 1, ${minX}, ${minY})`,
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

