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

import { Matrix3x3 } from '@opengpex/editor/core/geometry/matrix';
import { CameraState, Dimensions, ViewportPoint, Point2D, WorldRect, asWorldRect } from '@opengpex/editor/core/types';

export interface CameraCenterOptions {
  padding?: number;
  fixedScale?: number;
  maxScale?: number;
  offsetTop?: number;
  offsetBottom?: number;
  offsetLeft?: number;
  offsetRight?: number;
}

/**
 * Calculate optimal camera parameters (Fit into View)
 * [Internal] Logic: ensure that the content center and the viewport usable area center are physically aligned through matrix derivation.
 */
function calculateFit(
  viewport: Dimensions,
  content: Dimensions,
  options: CameraCenterOptions = {}
): CameraState {
  const {
    padding = 40,
    fixedScale,
    maxScale,
    offsetTop = 0,
    offsetBottom = 0,
    offsetLeft = 0,
    offsetRight = 0
  } = options;

  if (content.w === 0 || content.h === 0 || viewport.w === 0 || viewport.h === 0) {
    return { x: 0, y: 0, k: 1 };
  }

  const availableW = viewport.w - (padding * 2) - offsetLeft - offsetRight;
  const availableH = viewport.h - (padding * 2) - offsetTop - offsetBottom;

  let k: number;
  if (fixedScale !== undefined) {
    k = fixedScale;
  } else {
    const fitK = Math.min(availableW / content.w, availableH / content.h);
    // [REFACTOR-2026-06-22] Removed `* VIEWPORT_FIT_FACTOR (0.90)`; breathing
    // room is now expressed solely via the explicit `padding` option, avoiding
    // double-compensation between padding and an implicit shrink factor.
    k = maxScale !== undefined ? Math.min(maxScale, fitK) : fitK;
  }

  // Derive via matrix: we need the content center to coincide with the usable area center
  const centerX = (viewport.w + offsetLeft - offsetRight) / 2;
  const centerY = (viewport.h + offsetTop - offsetBottom) / 2;

  const p = Matrix3x3.translate(centerX, centerY).apply({
    x: -(content.w * k) / 2,
    y: -(content.h * k) / 2
  });

  return { x: p.x, y: p.y, k };
}

/**
 * Calculate camera center (centers image in viewport)
 */
export function getFitCamera(
  viewport: Dimensions,
  image: Dimensions,
  options: CameraCenterOptions = {}
): CameraState {
  return calculateFit(viewport, image, options);
}

/**
 * Project Zoom: Fixed-point scaling algorithm based on matrix derivation.
 * Logic: uses Matrix3x3.zoomAt to generate transform matrix and re-extract coordinates.
 */
export function projectZoom(
  current: CameraState,
  zoomDelta: number,
  anchor: ViewportPoint,
  limits: { min: number; max: number } = { min: 0.05, max: 20 }
): CameraState {
  const { x: curX, y: curY, k: curK } = current;
  const ratio = 1 + zoomDelta;
  const nextK = Math.max(limits.min, Math.min(curK * ratio, limits.max));

  // Core logic: M_camera = Translate(x, y) * Scale(k)
  // When performing fixed-point scaling: M_next = ZoomAt(anchor, actualRatio) * M_camera
  const actualRatio = nextK / curK;
  const M_cam = Matrix3x3.translate(curX, curY).multiply(Matrix3x3.scale(curK));
  const M_next = Matrix3x3.zoomAt(anchor, actualRatio).multiply(M_cam);

  return {
    x: M_next.tx,
    y: M_next.ty,
    k: nextK
  };
}

/**
 * Project Pan: Simple vector translation.
 */
export function projectPan(
  current: CameraState,
  delta: Point2D
): CameraState {
  return {
    ...current,
    x: current.x + delta.x,
    y: current.y + delta.y
  };
}

/**
 * Convert Matrix3x3 to semantic CameraState
 */
export function toCameraState(m: Matrix3x3): CameraState {
  return {
    x: m.tx,
    y: m.ty,
    k: m.a
  };
}

/**
 * Get viewport projection matrix (View Projection Matrix)
 * Logic: Screen = CameraTranslate * CameraScale * CanvasCenterTranslate * World
 */
export function getCameraMatrix(cam: CameraState, canvasDim: Dimensions): Matrix3x3 {
  return Matrix3x3.translate(cam.x, cam.y)
    .multiply(Matrix3x3.scale(cam.k))
    .multiply(Matrix3x3.translate(canvasDim.w / 2, canvasDim.h / 2));
}

/**
 * Calculate the viewport bounding rectangle under the world coordinate system (Viewport to World AABB)
 */
export function getViewportWorldRect(
  viewportDim: Dimensions,
  camera: CameraState,
  canvas: Dimensions,
  padding: number = 0
): WorldRect {
  const viewM = getCameraMatrix(camera, canvas);
  const invViewM = viewM.inverse();

  if (!invViewM) return asWorldRect({ x: 0, y: 0, w: 0, h: 0 });

  const corners = [
    invViewM.apply({ x: -padding, y: -padding }),
    invViewM.apply({ x: viewportDim.w + padding, y: -padding }),
    invViewM.apply({ x: viewportDim.w + padding, y: viewportDim.h + padding }),
    invViewM.apply({ x: -padding, y: viewportDim.h + padding })
  ];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of corners) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  return asWorldRect({
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY
  });
}
