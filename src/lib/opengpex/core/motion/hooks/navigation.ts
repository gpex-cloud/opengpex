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

import React, { useLayoutEffect, useCallback } from 'react';
import { useEditorServices, useEditorState } from '@opengpex/editor/core/context';
import { LayerUtils } from '@opengpex/editor/core/layer/LayerUtils';
import { VolatileState, Frame, CameraState, Rect, IMatrix3x3, LocalRect, WorldRect } from '@opengpex/editor/core/types';
import { useTicker } from './animation';
import { Motion } from '../index';

/**
 * MatrixRect: Matrix object carrying physical dimension information
 */
export interface MatrixRect extends IMatrix3x3 {
  w: number;
  h: number;
}

/**
 * useFastSync: Basic synchronization pipeline
 * Listens to the Ticker and executes user-defined sync callbacks in every frame.
 */
export function useFastSync<T extends Element>(
  ref: React.RefObject<T | null>,
  isActive: boolean,
  syncFn: (v: VolatileState, frame: Frame, cam: CameraState) => void
) {
  const { volatileRef } = useEditorServices();
  const { state } = useEditorState();
  const frame = state.activeFrameId ? state.frames.byId[state.activeFrameId] : undefined;

  const onTick = useCallback(() => {
    if (!ref.current || !frame || !isActive) return;

    const v = volatileRef.current;
    // [Performance Optimization] To ensure rotation, animation and other program-triggered changes can render in real time, no longer intercept Ticker
    // if (!force && !v.activeState.interacting) return;

    // --- Internal Merge Logic ---
    const frameDraft = v.buffered.frames[frame.id];

    // 1. Merge artboards (slow-track baseline + fast-track increment)
    // [Critical Fix] Do not use isInteracting as the sole guard.
    // isInteracting is synchronously set to false after commit, but React State updates asynchronously.
    // If we skip merging now, it will flash back to the old frame data (tearing).
    // Correct approach: as long as there are drafts in the buffer, continue to merge until React consumes them.
    let latestFrame = frame;
    const hasLayerDrafts = Object.keys(v.buffered.layers).length > 0;
    if (frameDraft || hasLayerDrafts) {
      latestFrame = { ...frame, ...frameDraft };
      // Deep stitching: merge fast-track layer increments into the layers array
      if (hasLayerDrafts) {
        const nextById: Record<string, import('@opengpex/editor/core/types').Layer> = {};
        for (const id of frame.layers.order) {
          nextById[id] = LayerUtils.mergeLayerDraft(frame.layers.byId[id], v.buffered.layers[LayerUtils.getCompositeKey(frame.id, id)]);
        }
        latestFrame.layers = { byId: nextById, order: frame.layers.order };
      }
    }

    // 2. Merge camera (fast-track first: use draft as long as it exists)
    const latestCam = frameDraft?.camera ? frameDraft.camera : frame.camera;

    syncFn(v, latestFrame, latestCam);
  }, [ref, frame, isActive, syncFn, volatileRef]);

  useLayoutEffect(() => {
    if (isActive) onTick();
  }, [onTick, isActive]);

  useTicker(() => {
    if (isActive) onTick();
  });
}


/**
 * useFastRectSync: Standard selection box synchronizer
 * Applicable to: crop boxes, selection boxes, multi-selection boxes, etc.
 * Auto-handling: fast/slow track merging, screen coordinate projection, pixel alignment.
 */
export function useFastRectSync<T extends Element>(
  ref: React.RefObject<T | null>,
  isActive: boolean,
  options: {
    selector: (v: VolatileState, frame: Frame, cam: CameraState) => Rect | null;
    space?: 'local' | 'world';
    pixelSnap?: boolean;
  }
) {
  const { geometry } = useEditorServices();
  const { selector, space = 'local', pixelSnap = true } = options;

  useFastSync(ref, isActive, (v, f, cam) => {
    const box = selector(v, f, cam);
    if (!box) return;

    let screenBox = space === 'local'
      ? geometry.space.localToScreenRect(box as LocalRect, f, cam)
      : geometry.space.worldToScreenRect(box as WorldRect, f, cam);

    if (pixelSnap) {
      screenBox = geometry.snapping.snapToPixel(screenBox);
    }

    Motion.set(ref.current, {
      left: screenBox.x,
      top: screenBox.y,
      width: screenBox.w,
      height: screenBox.h,
      overwrite: true
    });
  });
}

/**
 * useFastMatrixSync: Standard layer/transform synchronizer
 * Applicable to: layer outlines, deformation control points, etc.
 * Auto-handling: matrix decomposition, reverse rotation, dimension synchronization.
 */
export function useFastMatrixSync<T extends Element, L extends Element = Element>(
  ref: React.RefObject<T | null>,
  isActive: boolean,
  options: {
    selector: (v: VolatileState, frame: Frame, cam: CameraState) => MatrixRect | null;
    // Allow user to pass an optional "labelRef" to automatically handle counter-scale
    labelRef?: React.RefObject<L | null>;
  }
) {
  const { geometry } = useEditorServices();
  const { selector, labelRef } = options;

  useFastSync(ref, isActive, (v, f, cam) => {
    const matrix = selector(v, f, cam);
    // Note: cannot check !matrix.a here, because when rotation is 90 or 270 degrees, the a component (cos) is 0,
    // which would cause the sync logic to be misidentified and intercepted, leading to Gizmo jumping. Just check if matrix exists.
    if (!matrix) return;

    // 1. Decompose the matrix using standard operators
    const { scaleX, scaleY } = geometry.transform.decomposeMatrix(matrix);

    // 2. Construct a matrix with position and rotation only (descaled, adding 0.001 protection to prevent division by zero causing Infinity)
    const pureA = matrix.a / (scaleX || 0.001);
    const pureB = matrix.b / (scaleX || 0.001);
    const pureC = matrix.c / (scaleY || 0.001);
    const pureD = matrix.d / (scaleY || 0.001);

    // 3. Sync physical size and transform (using the Motion engine)
    Motion.set(ref.current, {
      width: (matrix.w || 0) * scaleX,
      height: (matrix.h || 0) * scaleY,
      transform: `matrix(${pureA}, ${pureB}, ${pureC}, ${pureD}, ${matrix.tx}, ${matrix.ty})`,
      overwrite: true
    });

    // 4. Automatically handle label counter-scaling to keep text size constant
    if (labelRef?.current) {
      Motion.set(labelRef.current, {
        scale: 1,
        overwrite: true
      });
    }
  });
}

/**
 * useFastSvgGroupSync: SVG vector group synchronizer (Viewport Clamping exclusive)
 * Applicable to: <g> nodes in full-screen SVG architecture, preventing large SVG sizes from overloading the GPU.
 * Auto-handling: coordinate projection, Scale matrix merging, and call native setAttribute('transform') to perfectly support vector-effect.
 */
export function useFastSvgGroupSync(
  ref: React.RefObject<SVGGElement | null>,
  isActive: boolean,
  options: {
    selector: (v: VolatileState, frame: Frame, cam: CameraState) => Rect | null;
    space?: 'local' | 'world';
  }
) {
  const { geometry } = useEditorServices();
  const { selector, space = 'local' } = options;

  useFastSync(ref, isActive, (v, f, cam) => {
    const box = selector(v, f, cam);
    if (!box || !ref.current) return;

    const k = geometry.getScale(f, cam);
    const { x, y } = space === 'local'
      ? geometry.space.localToScreen(box.x, box.y, f, cam)
      : geometry.space.worldToScreen(box.x, box.y, f, cam);

    ref.current.setAttribute('transform', `translate(${x}, ${y}) scale(${k})`);
  });
}
