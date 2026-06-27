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

import { Matrix3x3 } from '../matrix';
import {
  CameraState, Dimensions, WorldPoint, ViewportPoint, LocalPoint,
  LocalRect, WorldRect, Rect, asWorldPoint, asViewportPoint,
  asLocalPoint, asLocalRect, asWorldRect, Layer, IMatrix3x3, Point2D, Shape, NormalizedState
} from '@opengpex/editor/core/types';
import { getCameraMatrix } from './camera';
import { getLayerWorldMatrix } from './transform';

/**
 * Viewport physical coordinates -> World absolute coordinates (offset from center)
 */
export function screenToWorld(
  v_x: number, v_y: number,
  cam: CameraState,
  canvasDim: Dimensions
): WorldPoint {
  const invM = getCameraMatrix(cam, canvasDim).inverse();
  return asWorldPoint(invM.apply({ x: v_x, y: v_y }));
}

/**
 * World absolute coordinates -> Viewport physical coordinates
 */
export function worldToScreen(
  w_x: number, w_y: number,
  cam: CameraState,
  canvasDim: Dimensions
): ViewportPoint {
  const M = getCameraMatrix(cam, canvasDim);
  return asViewportPoint(M.apply({ x: w_x, y: w_y }));
}

/**
 * [Space Conversion] World absolute coordinates -> Local relative coordinates
 */
export function worldToLocal(
  w_x: number, w_y: number,
  canvasDim: Dimensions
): LocalPoint {
  return asLocalPoint(Matrix3x3.translate(canvasDim.w / 2, canvasDim.h / 2).apply({ x: w_x, y: w_y }));
}

/**
 * [Space Conversion] Local relative coordinates -> World absolute coordinates
 */
export function localToWorld(
  l_x: number, l_y: number,
  canvasDim: Dimensions
): WorldPoint {
  return asWorldPoint(Matrix3x3.translate(-canvasDim.w / 2, -canvasDim.h / 2).apply({ x: l_x, y: l_y }));
}

/**
 * [Space Conversion] World coordinate rectangle -> Local relative coordinate rectangle
 */
export function worldToLocalRect(w_rect: WorldRect, canvasDim: Dimensions): LocalRect {
  const l_pos = worldToLocal(w_rect.x, w_rect.y, canvasDim);
  return asLocalRect({ ...l_pos, w: w_rect.w, h: w_rect.h });
}

/**
 * [Space Conversion] Local relative coordinate rectangle -> World coordinate rectangle
 */
export function localToWorldRect(l_rect: Rect, canvasDim: Dimensions): WorldRect {
  const w_pos = localToWorld(l_rect.x, l_rect.y, canvasDim);
  return asWorldRect({ ...w_pos, w: l_rect.w, h: l_rect.h });
}

/**
 * Viewport physical coordinates -> Local relative coordinates
 */
export function screenToLocal(
  v_x: number, v_y: number,
  cam: CameraState
): LocalPoint {
  const invM = Matrix3x3.translate(cam.x, cam.y)
    .multiply(Matrix3x3.scale(cam.k))
    .inverse();
  return asLocalPoint(invM.apply({ x: v_x, y: v_y }));
}

/**
 * Local relative coordinates -> Viewport physical coordinates
 */
export function localToScreen(
  l_x: number, l_y: number,
  cam: CameraState
): ViewportPoint {
  const M = Matrix3x3.translate(cam.x, cam.y)
    .multiply(Matrix3x3.scale(cam.k));
  return asViewportPoint(M.apply({ x: l_x, y: l_y }));
}

/**
 * Calculate projection of selection in layer local space (AABB)
 * [Internal] Used for worldToLocalShape
 */
export function getLayerLocalAABB(layer: Layer, worldRect: WorldRect, w_matrix?: IMatrix3x3): LocalRect {
  // Force converting to Matrix3x3 instance as we need to call the inverse method
  const M = w_matrix instanceof Matrix3x3 ? w_matrix : (w_matrix ? new Matrix3x3(w_matrix.a, w_matrix.b, w_matrix.c, w_matrix.d, w_matrix.tx, w_matrix.ty) : getLayerWorldMatrix(layer));
  const invM = M.inverse();

  const corners = [
    { x: worldRect.x, y: worldRect.y },
    { x: worldRect.x + worldRect.w, y: worldRect.y },
    { x: worldRect.x, y: worldRect.y + worldRect.h },
    { x: worldRect.x + worldRect.w, y: worldRect.y + worldRect.h }
  ];

  const localCorners = corners.map(p => invM.apply(p));

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  localCorners.forEach(p => {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  });

  const x1 = Math.floor(minX);
  const y1 = Math.floor(minY);
  const x2 = Math.ceil(maxX);
  const y2 = Math.ceil(maxY);

  return asLocalRect({
    x: x1,
    y: y1,
    w: Math.max(1, x2 - x1),
    h: Math.max(1, y2 - y1)
  });
}

// --- The following content is merged from layout.ts ---

/**
 * Core geometric algorithm: calculates the scaled rectangle
 * Using Math.min/Math.abs scheme, naturally supports reverse expansion across anchors, with highly stable logic.
 */
export function calculateResizedRect(
  curPoint: WorldPoint,
  anchor: WorldPoint,
  aspect?: number,
  dragType: string = 'se',
  startDim: Dimensions = { w: 0, h: 0 }
): WorldRect {
  let nw: number = 0, nh: number = 0;
  const isEdge = ['n', 's', 'e', 'w'].includes(dragType);

  // 1. Calculate absolute value of original offset
  let dw = Math.abs(curPoint.x - anchor.x);
  let dh = Math.abs(curPoint.y - anchor.y);

  // 2. If it is a single-sided handle, lock dimensions of the other dimension
  if (isEdge && !aspect) {
    if (dragType === 'n' || dragType === 's') dw = startDim.w;
    if (dragType === 'w' || dragType === 'e') dh = startDim.h;
  }

  // 3. Handle proportion constraints
  if (aspect) {
    if (isEdge) {
      if (dragType === 'w' || dragType === 'e') {
        nw = dw;
        nh = nw / aspect;
      } else {
        nh = dh;
        nw = nh * aspect;
      }
    } else {
      if (dw / (dh || 0.001) > aspect) {
        nw = dw;
        nh = nw / aspect;
      } else {
        nh = dh;
        nw = nh * aspect;
      }
    }
  } else {
    nw = dw;
    nh = dh;
  }

  // 4. Universal coordinate formula: top-left is always min, size is always abs
  // This ensures the rectangle is always stable no matter how the mouse moves
  return asWorldRect({
    x: Math.min(anchor.x, curPoint.x),
    y: Math.min(anchor.y, curPoint.y),
    w: nw,
    h: nh
  });
}

/**
 * Proportion-aware boundary truncation
 */
export function clampRectWithAspect(
  rect: Rect,
  bounds: Dimensions,
  w_anchor: WorldPoint,
  aspect?: number
): Rect {
  const { x, y, w, h } = rect;
  const { w: bw, h: bh } = bounds;

  if (!aspect) {
    const nextW = Math.min(w, (x < w_anchor.x) ? w_anchor.x : bw - w_anchor.x);
    const nextH = Math.min(h, (y < w_anchor.y) ? w_anchor.y : bh - w_anchor.y);
    return asWorldRect({
      x: Math.min(w_anchor.x, x < w_anchor.x ? w_anchor.x - nextW : w_anchor.x),
      y: Math.min(w_anchor.y, y < w_anchor.y ? w_anchor.y - nextH : w_anchor.y),
      w: nextW,
      h: nextH
    });
  }

  let ratio = 1;
  const maxW = (x < w_anchor.x) ? w_anchor.x : bw - w_anchor.x;
  const maxH = (y < w_anchor.y) ? w_anchor.y : bh - w_anchor.y;

  if (w > maxW) ratio = Math.min(ratio, maxW / w);
  if (h > maxH) ratio = Math.min(ratio, maxH / h);

  const finalW = w * ratio;
  const finalH = h * ratio;

  return asWorldRect({
    x: Math.min(w_anchor.x, x < w_anchor.x ? w_anchor.x - finalW : w_anchor.x),
    y: Math.min(w_anchor.y, y < w_anchor.y ? w_anchor.y - finalH : w_anchor.y),
    w: finalW,
    h: finalH
  });
}

/**
 * Constrain point within rectangle and return overflow vector (Delta)
 */
export function clampPointToRect(
  p: Point2D,
  rect: Dimensions
): { x: number, y: number, dx: number, dy: number } {
  const nextX = Math.max(0, Math.min(p.x, rect.w));
  const nextY = Math.max(0, Math.min(p.y, rect.h));
  return {
    x: nextX,
    y: nextY,
    dx: p.x - nextX,
    dy: p.y - nextY
  };
}

/**
 * Balance displacement vector according to proportion
 */
export function balanceVectorByAspect(
  v: Point2D,
  aspect: number,
  direction: Point2D // 1 or -1 for each axis
): Point2D {
  const absX = Math.abs(v.x);
  const absY = Math.abs(v.y);

  if (absX / aspect > absY) {
    return {
      x: v.x,
      y: direction.y * (absX / aspect)
    };
  } else {
    return {
      x: direction.x * (absY * aspect),
      y: v.y
    };
  }
}

/**
 * Constrain rectangle to maintain minimum intersection (Overlap) with container rectangle
 * Prevents selection or layer from moving completely out of visible area.
 */
export function clampRectWithOverlap<T extends Rect>(
  rect: T,
  boundary: Dimensions,
  minOverlap = 1
): T {
  const next = { ...rect };
  next.x = Math.max(minOverlap - next.w, Math.min(next.x, boundary.w - minOverlap));
  next.y = Math.max(minOverlap - next.h, Math.min(next.y, boundary.h - minOverlap));
  return next;
}

/**
 * Calculate intersection of two coordinate rectangles (Rect Intersection)
 */
export function getRectIntersection<T extends Rect>(r1: T, r2: T, minSize = 0.5): T | null {
  const x1 = Math.max(r1.x, r2.x);
  const y1 = Math.max(r1.y, r2.y);
  const x2 = Math.min(r1.x + r1.w, r2.x + r2.w);
  const y2 = Math.min(r1.y + r1.h, r2.y + r2.h);

  const width = x2 - x1;
  const height = y2 - y1;

  if (width < minSize || height < minSize) return null;

  return { x: x1, y: y1, w: width, h: height } as T;
}

/**
 * Calculate physical bounding box (AABB) of layer in world coordinates
 * 
 * [Coordinate System Offset Compensation Description]
 * When a layer is a cropped fragment layer (e.g., a local layer cut out by Cmd+J), its underlying asset is actually still the uncropped original large image.
 * To ensure the UI selection frame and transform center point logically align with user intuition, the geometry engine adopts a "relative offset" design:
 * 1. Fragment's local coordinate system completely coincides with the original large image (origin 0,0 corresponds to top-left of the large image).
 * 2. Fragment's actual valid pixels are bound by `visibleShape.rect` (i.e. rect.x, rect.y), and the renderer draws the original image at this offset.
 * 3. As compensation, `getLayerWorldMatrix` (the incoming M matrix) automatically superimposes a reverse translation of `-rect.x, -rect.y` internally,
 *    thereby "pulling back" these offset pixels to the user-specified world coordinate center (cx, cy).
 * 
 * Therefore, when deriving the physical bounding box actually occupying the screen, we cannot simply extract a rectangle from `0, 0` to `w, h`.
 * The real pixel physical center is located at `(rect.x + rect.w / 2, rect.y + rect.h / 2)` in the large image coordinate system.
 * Only by inputting this offset center coordinate into the M matrix will it perfectly hedge with the internal negative offset of M,
 * ultimately outputting an absolutely accurate world bounding box. This prevents frustum culling at high magnifications from accidentally deleting the current fragment.
 */
export function getLayerBoundingBox(l: Layer, w_matrix?: IMatrix3x3): WorldRect {
  const rect = l.visibleShape?.rect || { x: 0, y: 0, w: l.bounding.w, h: l.bounding.h };
  const M = w_matrix instanceof Matrix3x3 ? w_matrix : (w_matrix ? new Matrix3x3(w_matrix.a, w_matrix.b, w_matrix.c, w_matrix.d, w_matrix.tx, w_matrix.ty) : getLayerWorldMatrix(l));

  const centerMatrix = M.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
  const bbox = Matrix3x3.extractAABB({ w: rect.w, h: rect.h }, centerMatrix);
  return asWorldRect(bbox);
}

/**
 * Calculate four rectangular areas around the center hole (top, bottom, left, right)
 */
export function getSurroundingRects<T extends Rect>(outer: T, hole: T): { top: T, bottom: T, left: T, right: T } {
  const intersect = {
    top: Math.max(outer.y, hole.y),
    bottom: Math.min(outer.y + outer.h, hole.y + hole.h),
    left: Math.max(outer.x, hole.x),
    right: Math.min(outer.x + outer.w, hole.x + hole.w)
  };

  const topH = Math.max(0, intersect.top - outer.y);
  const bottomH = Math.max(0, (outer.y + outer.h) - intersect.bottom);
  const midH = Math.max(0, intersect.bottom - intersect.top);

  const leftW = Math.max(0, intersect.left - outer.x);
  const rightW = Math.max(0, (outer.x + outer.w) - intersect.right);

  return {
    top: { ...outer, x: outer.x, y: outer.y, w: outer.w, h: topH } as T,
    bottom: { ...outer, x: outer.x, y: intersect.bottom, w: outer.w, h: bottomH } as T,
    left: { ...outer, x: outer.x, y: intersect.top, w: leftW, h: midH } as T,
    right: { ...outer, x: intersect.right, y: intersect.top, w: rightW, h: midH } as T
  };
}

/**
 * Determine if rectangle contains point
 */
export function isPointInRect(p: Point2D, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/**
 * Determine if shape contains point
 */
export function isPointInShape(p: Point2D, shape: Shape): boolean {
  if (shape.type === 'circle') {
    const rx = shape.rect.w / 2;
    const ry = shape.rect.h / 2;
    const cx = shape.rect.x + rx;
    const cy = shape.rect.y + ry;
    if (rx === 0 || ry === 0) return false;
    return Math.pow(p.x - cx, 2) / Math.pow(rx, 2) + Math.pow(p.y - cy, 2) / Math.pow(ry, 2) <= 1;
  }
  // Default to rectangle (type === 'rect')
  return isPointInRect(p, shape.rect);
}

/**
 * testLayerHit: Determines if a world coordinate point hits a specified layer
 */
export function testLayerHit(w_pos: WorldPoint, layer: Layer): boolean {
  if (!layer.visible || layer.interactive === false) return false;

  const w_matrix = getLayerWorldMatrix(layer);
  const invM = w_matrix.inverse();
  const localP = invM.apply(w_pos) as LocalPoint;

  if (layer.visibleShape) {
    return isPointInShape(localP, layer.visibleShape);
  }

  // Defensive fallback: if the layer does not define visibleShape (e.g., newly created or special layer), default to its full bounding rectangle
  const defaultRect = { x: 0, y: 0, w: layer.bounding.w, h: layer.bounding.h };
  return isPointInRect(localP, defaultRect);
}

/**
 * pickLayersAt: Gets all layers under the specified position (from top to bottom)
 */
export function pickLayersAt(w_pos: WorldPoint, layers: NormalizedState<Layer>): Layer[] {
  const hits: Layer[] = [];
  for (let i = layers.order.length - 1; i >= 0; i--) {
    const layer = layers.byId[layers.order[i]];
    if (layer && testLayerHit(w_pos, layer)) {
      hits.push(layer);
    }
  }
  return hits;
}

/**
 * pickTopLayer: Gets the topmost layer under the specified position
 */
export function pickTopLayer(w_pos: WorldPoint, layers: NormalizedState<Layer>): Layer | null {
  for (let i = layers.order.length - 1; i >= 0; i--) {
    const layer = layers.byId[layers.order[i]];
    if (layer && testLayerHit(w_pos, layer)) {
      return layer;
    }
  }
  return null;
}

/**
 * Calculate minimum bounding box of two rectangles (Rect Union)
 */
export function getRectUnion<T extends Rect>(r1: T, r2: T): T {
  const minX = Math.min(r1.x, r2.x);
  const minY = Math.min(r1.y, r2.y);
  const maxX = Math.max(r1.x + r1.w, r2.x + r2.w);
  const maxY = Math.max(r1.y + r1.h, r2.y + r2.h);
  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY
  } as T;
}

/**
 * Calculate unified minimum bounding box of multiple rectangles (Multi-Rect Union)
 */
export function getMultiRectUnion<T extends Rect>(rects: T[]): T | null {
  if (rects.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY
  } as T;
}

/**
 * Calculate absolute geometric center point of rectangle
 */
export function getRectCenter(rect: Rect): Point2D {
  return {
    x: rect.x + rect.w / 2,
    y: rect.y + rect.h / 2
  };
}

