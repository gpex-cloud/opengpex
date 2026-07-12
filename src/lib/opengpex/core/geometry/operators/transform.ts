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

import { Matrix3x3, GeometryOp } from '../matrix';
import { Layer, Frame, IMatrix3x3, asLocalRect, asLocalPoint, asLocalPolygon, LocalPolygon, LocalShape, LayerPoseOverride, isPolygon } from '@opengpex/editor/core/types';
import { computePolygonBounds } from './polygon';

/**
 * [Generic] Core geometric operator: calculate transform matrix of any asset in world coordinate system
 *
 * Design contract:
 *   Matrix = Translate(cx, cy) × Orientation(rotation, flip) × Translate(-bounding.w/2, -bounding.h/2)
 *
 * This places the center of the layer's BOUNDING BOX at world coordinate (cx, cy).
 * The painter (painter.ts) then draws content at visibleShape.rect offset (vx, vy) within
 * this bounding-local coordinate space, so content naturally appears at its correct position.
 *
 * [Historical note / Bugfix 2026-07-04]
 * Previously this function used visibleShape.rect for centering and included a -rect.x/-rect.y
 * "compensation" translation. That design caused imported images with non-zero contentBounds
 * (e.g., images with transparent borders) to have their visible content forced to canvas center
 * instead of appearing at its true position. The fix: always center on bounding, let the painter
 * handle visibleShape offset naturally via drawImage(source, vx, vy, vw, vh, vx, vy, vw, vh).
 *
 * Safe because all existing fragment layers have visibleShape.rect at (0, 0) — the old
 * compensation was always a no-op for them.
 */
function computeWorldMatrix(props: {
  cx: number;
  cy: number;
  rotation: number;
  flip: { h: boolean; v: boolean };
  bounding: { w: number; h: number };
}): Matrix3x3 {
  const { cx, cy, rotation, flip, bounding } = props;

  return Matrix3x3.translate(cx, cy)
    .multiply(getOrientationMatrix(rotation, flip))
    .multiply(Matrix3x3.translate(-bounding.w / 2, -bounding.h / 2));
}

/**
 * [External] Convert semantic state to 2x2 rotation-mirror matrix part
 */
function getOrientationMatrix(rotation: number, flip?: { h: boolean, v: boolean }): Matrix3x3 {
  const safeFlip = flip || { h: false, v: false };
  const R = Matrix3x3.rotate(rotation);
  const F = new Matrix3x3(safeFlip.h ? -1 : 1, 0, 0, safeFlip.v ? -1 : 1, 0, 0);
  return R.multiply(F);
}

/**
 * Compute the correct (cx, cy) world-space anchor for a fragment layer whose
 * visible content starts at `visibleOffset` within its bounding box.
 *
 * Background:
 *   WorldMatrix = Translate(cx, cy) × Orientation(rotation, flip) × Translate(-bw/2, -bh/2)
 *   When bounding = visibleShape size, the content center in world space becomes:
 *     worldCenter = (cx, cy) + Orientation × (vx, vy)
 *   Solving for (cx, cy):
 *     (cx, cy) = worldCenter − Orientation × (vx, vy)
 *
 * The previous simplified formula (cx = center.x - vx) only works when
 * Orientation is identity (no rotation, no flip). This function handles
 * the general case correctly.
 */
export function computeFragmentCenter(
  worldCenter: { x: number; y: number },
  visibleOffset: { x: number; y: number },
  rotation: number,
  flip: { h: boolean; v: boolean }
): { x: number; y: number } {
  const O = getOrientationMatrix(rotation, flip);
  const rotatedOffset = O.apply(visibleOffset);
  return {
    x: worldCenter.x - rotatedOffset.x,
    y: worldCenter.y - rotatedOffset.y,
  };
}

/**
 * [External] Fuses all geometric elements: center position, viewport shape (visibleShape), rotation, flip, scaling, etc.
 */
export function getLayerWorldMatrix(layer: Layer, override?: LayerPoseOverride): Matrix3x3 {
  const cx = override?.cx ?? layer.cx;
  const cy = override?.cy ?? layer.cy;
  const rotation = override?.rotation ?? layer.rotation;

  return computeWorldMatrix({
    cx,
    cy,
    rotation,
    flip: layer.flip,
    bounding: layer.bounding
  });
}

/**
 * Derived method: directly get Local Space matrix (top-left reference)
 */
export function getLayerLocalMatrix(layer: Layer, canvasDim: { w: number, h: number }, override?: LayerPoseOverride): Matrix3x3 {
  const w_matrix = getLayerWorldMatrix(layer, override);
  return Matrix3x3.translate(canvasDim.w / 2, canvasDim.h / 2).multiply(w_matrix);
}

/**
 * DecomposedMatrix: Semantic pose parameters after matrix decomposition
 */
export interface DecomposedMatrix {
  rotation: number;
  flip: { h: boolean; v: boolean };
  scaleX: number;
  scaleY: number;
}

/**
 * [Internal] Matrix decomposition: extract rotation, scaling, flip and other parameters from IMatrix3x3
 */
export function decomposeMatrix(M: IMatrix3x3, refRotation: number = 0): DecomposedMatrix {
  const { a, b, c, d } = M;

  // 1. Calculate scaling (Scale)
  // Pythagorean theorem: a^2 + b^2 = scaleX^2; c^2 + d^2 = scaleY^2
  const scaleX = Math.sqrt(a * a + b * b);
  const scaleY = Math.sqrt(c * c + d * d);

  // 2. Determine mirroring (Determinant)
  const det = a * d - b * c;
  const isMirrored = det < 0;

  const getAngleDist = (angleA: number, angleB: number) => {
    const diff = Math.abs(angleA - (angleB % 360 + 360) % 360);
    return Math.min(diff, 360 - diff);
  };

  // 3. Handle non-mirrored case
  if (!isMirrored) {
    let angle = Math.round((Math.atan2(b, a) * 180) / Math.PI);
    angle = ((angle % 360) + 360) % 360;

    const angleA = angle;
    const angleB = (angle + 180) % 360;
    const distA = getAngleDist(angleA, refRotation);
    const distB = getAngleDist(angleB, refRotation);

    if (distA <= distB) {
      return { rotation: angleA, flip: { h: false, v: false }, scaleX, scaleY };
    } else {
      return { rotation: angleB, flip: { h: true, v: true }, scaleX, scaleY };
    }
  }

  // 4. Handle mirrored case (horizontal flip or vertical flip)
  let thetaH = Math.round((Math.atan2(-b, -a) * 180) / Math.PI);
  thetaH = ((thetaH % 360) + 360) % 360;

  let thetaV = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  thetaV = ((thetaV % 360) + 360) % 360;

  const distH = getAngleDist(thetaH, refRotation);
  const distV = getAngleDist(thetaV, refRotation);

  if (distH <= distV) {
    return { rotation: thetaH, flip: { h: true, v: false }, scaleX, scaleY };
  } else {
    return { rotation: thetaV, flip: { h: false, v: true }, scaleX, scaleY };
  }
}

/**
 * Transform a LocalPolygon by applying a D4 symmetry operation (rotation / flip)
 * within a container of size (oldW, oldH).
 *
 * Point transforms (derived from Matrix3x3.transformRect with w=0, h=0):
 *   rotate_r: (px, py) → (oldH - py, px)
 *   rotate_l: (px, py) → (py, oldW - px)
 *   flip_h:   (px, py) → (oldW - px, py)
 *   flip_v:   (px, py) → (px, oldH - py)
 */
function transformPolygon(
  poly: LocalPolygon,
  container: { w: number; h: number },
  op: GeometryOp
): LocalPolygon {
  const { w: oldW, h: oldH } = container;

  const transformPoint = (px: number, py: number): { x: number; y: number } => {
    switch (op) {
      case 'rotate_r': return { x: oldH - py, y: px };
      case 'rotate_l': return { x: py, y: oldW - px };
      case 'flip_h': return { x: oldW - px, y: py };
      case 'flip_v': return { x: px, y: oldH - py };
      default: return { x: px, y: py };
    }
  };

  const nextRings = poly.rings.map(ring =>
    ring.map(p => asLocalPoint(transformPoint(p.x, p.y)))
  );

  const nextBounds = asLocalRect(computePolygonBounds(nextRings));
  return asLocalPolygon(nextRings, nextBounds, poly.antiAliased);
}

/**
 * Execute artboard-level geometric update (rotation/flip)
 */
export function transformFrame(
  frame: Frame,
  operation: 'rotate_r' | 'rotate_l' | 'flip_h' | 'flip_v'
) {
  let O: Matrix3x3;
  const isRotation = operation.startsWith('rotate');
  const oldW = frame.canvas.w;
  const oldH = frame.canvas.h;

  switch (operation) {
    case 'rotate_r': O = Matrix3x3.rotate90(1); break;
    case 'rotate_l': O = Matrix3x3.rotate90(-1); break;
    case 'flip_h': O = Matrix3x3.flipH(); break;
    case 'flip_v': O = Matrix3x3.flipV(); break;
    default: return frame;
  }

  const nextById: Record<string, typeof frame.layers.byId[string]> = {};
  frame.layers.order.forEach(id => {
    const l = frame.layers.byId[id];
    const L_orient = getOrientationMatrix(l.rotation, l.flip);
    const nextL_orient = O.multiply(L_orient);
    const { rotation, flip } = decomposeMatrix(nextL_orient, l.rotation);
    const nextP = O.apply({ x: l.cx, y: l.cy });

    nextById[id] = { ...l, cx: nextP.x, cy: nextP.y, rotation, flip };
  });

  const nextW = isRotation ? oldH : oldW;
  const nextH = isRotation ? oldW : oldH;
  const delta = isRotation ? (operation === 'rotate_r' ? 90 : -90) : 0;

  const nextCamera = { ...frame.camera };
  if (isRotation) {
    nextCamera.x += (oldW - nextW) / 2 * frame.camera.k;
    nextCamera.y += (oldH - nextH) / 2 * frame.camera.k;
  }

  const nextCanvasCropBox = Matrix3x3.transformRect(frame.canvasCropBox.rect, frame.canvas, operation);

  // Transform clipBoxes — each slot is either a LocalShape (rect/ellipse) or
  // a LocalPolygon (lasso/wand). Both must follow the same D4 symmetry
  // operation so the selection stays aligned with pixels after rotation/flip.
  const nextClipBoxes: Record<string, LocalShape | LocalPolygon> = {};
  for (const [toolId, entry] of Object.entries(frame.clipBoxes)) {
    if (!entry) continue;
    if (isPolygon(entry)) {
      // LocalPolygon
      nextClipBoxes[toolId] = transformPolygon(entry as LocalPolygon, frame.canvas, operation);
    } else {
      // LocalShape — transform rect, keep shape metadata
      const transformed = Matrix3x3.transformRect((entry as LocalShape).rect, frame.canvas, operation);
      nextClipBoxes[toolId] = { ...(entry as LocalShape), rect: asLocalRect(transformed) };
    }
  }

  return {
    ...frame,
    canvas: { w: nextW, h: nextH },
    rotation: (frame.rotation || 0) + delta,
    layers: { byId: nextById, order: frame.layers.order },
    camera: nextCamera,
    clipBoxes: nextClipBoxes,
    canvasCropBox: { ...frame.canvasCropBox, rect: asLocalRect(nextCanvasCropBox) },
  };
}
