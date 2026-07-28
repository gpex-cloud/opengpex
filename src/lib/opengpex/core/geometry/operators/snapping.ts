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
import { Dimensions, Frame, Layer, WorldPoint, Rect, asWorldPoint, Point2D, WorldRect, asLocalRect } from '@opengpex/editor/core/types';
import { getLayerWorldMatrix } from './transform';
import { worldToLocalRect, localToWorldRect } from './space';

/**
 * Snap rectangle to physical pixel grid
 */
export function snapToPixel(obj: Rect, strategy?: 'round' | 'floor' | 'ceil'): Rect;
/**
 * Snap point to physical pixel grid
 */
export function snapToPixel(obj: Point2D, strategy?: 'round' | 'floor' | 'ceil'): Point2D;
/**
 * Implementation
 */
export function snapToPixel(obj: Rect | Point2D, strategy: 'round' | 'floor' | 'ceil' = 'round'): Rect | Point2D {
  const fn = Math[strategy];
  if ('w' in obj) {
    return {
      x: fn(obj.x),
      y: fn(obj.y),
      w: fn(obj.w),
      h: fn(obj.h)
    };
  }
  return {
    x: fn(obj.x),
    y: fn(obj.y)
  };
}


/**
 * SmartGuideData: Smart alignment guide line data structure
 */
export interface SmartGuideData {
  x?: number;
  y?: number;
  isBirthX?: boolean;
  isBirthY?: boolean;
}

/**
 * Snap filter options for fine-grained control over which layers participate.
 */
export interface SnapFilterOptions {
  snapToCanvas?: boolean;
  snapToBirth?: boolean;
  snapToLayers?: boolean;
  excludeLayerTypes?: string[];
  ignoreLockedLayers?: boolean;
  ignoreSmallLayers?: boolean;
  smallLayerThreshold?: number;
  maxSnapTargets?: number;
}

/**
 * Rectangle-level snapping (usually used for layer dragging)
 */
export function snapRect(
  rect: Rect,
  frame: Frame,
  options: { clamp?: boolean, threshold?: number, excludeLayerId?: string } & SnapFilterOptions = {}
): { x: number, y: number, smartguides: SmartGuideData | null } {
  const { w: iw, h: ih } = frame.canvas;
  const c2w = Matrix3x3.translate(-iw / 2, -ih / 2);
  const w2c = c2w.inverse();

  const snapped = getSnappedPosition(
    asWorldPoint(c2w.apply({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 })),
    { w: rect.w, h: rect.h }, frame, options.excludeLayerId || '', options.threshold ?? 15,
    options
  );

  const sc = w2c.apply({ x: snapped.x, y: snapped.y });
  let nx = sc.x - rect.w / 2, ny = sc.y - rect.h / 2;

  if (options.clamp) {
    nx = Math.max(0, Math.min(nx, iw - rect.w));
    ny = Math.max(0, Math.min(ny, ih - rect.h));
  }
  return { x: nx, y: ny, smartguides: snapped.smartguides };
}

/**
 * SnapTarget: Represents a snap target in world-space AABB form.
 * All comparisons happen purely in world space — no coordinate space mixing.
 */
interface SnapTarget {
  /** World-space AABB center */
  center: Point2D;
  /** World-space AABB half-size (halfW, halfH) */
  halfSize: Point2D;
  /** Type identifier */
  type: 'canvas' | 'birth' | 'layer';
}

/**
 * Compute the world-space axis-aligned bounding box (AABB) for a layer,
 * using 4-corner projection of the visible rect through the world matrix.
 */
function getLayerWorldAABB(layer: Layer): { center: Point2D; halfSize: Point2D } {
  const rect = layer.visibleShape?.rect || { x: 0, y: 0, w: layer.bounding.w, h: layer.bounding.h };
  const wm = getLayerWorldMatrix(layer);

  // Project 4 corners of the visible rect to world space
  const corners = [
    wm.apply({ x: rect.x, y: rect.y }),
    wm.apply({ x: rect.x + rect.w, y: rect.y }),
    wm.apply({ x: rect.x, y: rect.y + rect.h }),
    wm.apply({ x: rect.x + rect.w, y: rect.y + rect.h }),
  ];

  const xs = corners.map(c => c.x);
  const ys = corners.map(c => c.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  return {
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    halfSize: { x: (maxX - minX) / 2, y: (maxY - minY) / 2 }
  };
}

/**
 * Calculate snapped coordinates using pure world-space AABB edge comparison.
 *
 * All comparisons happen in world space:
 * - Moving layer edges = w_pos.x ± targetDim.w/2 (world-space AABB)
 * - Target layer edges = target world AABB's left/center/right
 * - Guide coordinates = the matched target edge (world-space constant, independent of moving layer position)
 */
function getSnappedPosition(
  w_pos: WorldPoint,
  targetDim: Dimensions,
  frame: Frame,
  activeLayerId: string,
  threshold: number = 15,
  filterOptions: SnapFilterOptions = {}
): { x: number, y: number, smartguides: SmartGuideData | null } {
  const cameraScale = frame.camera?.k || 1;
  // 💡 1. Dynamic alignment threshold: constant screen pixel visual snapping hot zone
  const dynamicThreshold = threshold / cameraScale;

  const activeLayer = activeLayerId ? frame.layers.byId[activeLayerId] : null;

  // ── 1. Build snap targets (pure world-space AABB) ──
  const targets: SnapTarget[] = [];

  // Canvas (configurable)
  if (filterOptions.snapToCanvas !== false) {
    targets.push({
      center: { x: 0, y: 0 },
      halfSize: { x: frame.canvas.w / 2, y: frame.canvas.h / 2 },
      type: 'canvas'
    });
  }

  // Birth position (configurable)
  // Note: birthCenter stores bounding center (cx/cy) at creation. We must convert it
  // to the visible content center so it matches the w_pos coordinate system.
  if (filterOptions.snapToBirth !== false && activeLayer?.birthCenter) {
    const birthRect = activeLayer.visibleShape?.rect || { x: 0, y: 0, w: activeLayer.bounding.w, h: activeLayer.bounding.h };
    const birthWm = getLayerWorldMatrix(activeLayer, {
      cx: activeLayer.birthCenter.cx,
      cy: activeLayer.birthCenter.cy
    });
    const birthVisibleCenter = birthWm.apply({
      x: birthRect.x + birthRect.w / 2,
      y: birthRect.y + birthRect.h / 2
    });
    targets.push({
      center: birthVisibleCenter,
      halfSize: { x: 0, y: 0 },
      type: 'birth'
    });
  }

  // Layers (configurable, with fine-grained filtering)
  if (filterOptions.snapToLayers !== false) {
    const layerTargets = frame.layers.order
      .map(id => frame.layers.byId[id])
      .filter(l => l.id !== activeLayerId && l.visible && l.role === 'host')
      // Layer type exclusion
      .filter(l => {
        const excludeTypes = filterOptions.excludeLayerTypes || [];
        return !excludeTypes.includes(l.type);
      })
      // Locked layer exclusion
      .filter(l => {
        if (filterOptions.ignoreLockedLayers === false) return true;
        return !l.locked;
      })
      // Small fragment area filter
      .filter(l => {
        if (filterOptions.ignoreSmallLayers === false) return true;
        const areaThreshold = filterOptions.smallLayerThreshold || 400;
        const screenArea = l.bounding.w * l.bounding.h * cameraScale * cameraScale;
        return screenArea > areaThreshold;
      })
      // Spatial distance filter
      .filter(l => {
        const dx = l.cx - w_pos.x;
        const dy = l.cy - w_pos.y;
        const distOnScreen = Math.sqrt(dx * dx + dy * dy) * cameraScale;
        return distOnScreen < 1500;
      })
      // Sort by distance and limit count
      .sort((a, b) => {
        const da = Math.hypot(a.cx - w_pos.x, a.cy - w_pos.y);
        const db = Math.hypot(b.cx - w_pos.x, b.cy - w_pos.y);
        return da - db;
      })
      .slice(0, filterOptions.maxSnapTargets || 8);

    for (const l of layerTargets) {
      const aabb = getLayerWorldAABB(l);
      targets.push({ center: aabb.center, halfSize: aabb.halfSize, type: 'layer' });
    }
  }

  // ── 2. Moving layer edge offsets (world space) ──
  const [dw, dh] = [targetDim.w / 2, targetDim.h / 2];
  // Center first so center alignment wins on equal deviation
  const srcEdgesX = targetDim.w === 0 ? [0] : [0, -dw, dw];
  const srcEdgesY = targetDim.h === 0 ? [0] : [0, -dh, dh];

  // ── 3. Pure world-space comparison ──
  let bestDiffX = dynamicThreshold;
  let bestNextX: number | undefined = undefined;
  let bestGuideX: number | undefined = undefined;
  let bestIsBirthX = false;

  let bestDiffY = dynamicThreshold;
  let bestNextY: number | undefined = undefined;
  let bestGuideY: number | undefined = undefined;
  let bestIsBirthY = false;

  for (const t of targets) {
    // Target edges in world space
    const tEdgesX = t.halfSize.x === 0
      ? [t.center.x]
      : [t.center.x, t.center.x - t.halfSize.x, t.center.x + t.halfSize.x];
    const tEdgesY = t.halfSize.y === 0
      ? [t.center.y]
      : [t.center.y, t.center.y - t.halfSize.y, t.center.y + t.halfSize.y];

    // X-axis snapping
    for (const tEx of tEdgesX) {
      for (const dx of srcEdgesX) {
        // Moving layer's edge in world space at current position
        const srcEdge = w_pos.x + dx;
        const diff = Math.abs(srcEdge - tEx);

        // 💡 Center-to-center preference: 0.8 discount for center alignment stability
        const isCenterToCenter = (dx === 0 && tEx === t.center.x);
        const evalDiff = isCenterToCenter ? diff * 0.8 : diff;

        if (evalDiff < bestDiffX) {
          bestDiffX = evalDiff;
          // ★ Snapped moving layer center = target edge - moving layer internal offset
          bestNextX = tEx - dx;
          // ★ Guide position = target edge (world-space constant, independent of moving layer)
          bestGuideX = tEx;
          bestIsBirthX = t.type === 'birth';
        }
      }
    }

    // Y-axis snapping
    for (const tEy of tEdgesY) {
      for (const dy of srcEdgesY) {
        const srcEdge = w_pos.y + dy;
        const diff = Math.abs(srcEdge - tEy);

        // 💡 Center-to-center preference coefficient for Y axis
        const isCenterToCenter = (dy === 0 && tEy === t.center.y);
        const evalDiff = isCenterToCenter ? diff * 0.8 : diff;

        if (evalDiff < bestDiffY) {
          bestDiffY = evalDiff;
          bestNextY = tEy - dy;
          bestGuideY = tEy;
          bestIsBirthY = t.type === 'birth';
        }
      }
    }
  }

  // ── 4. Output ──
  let nextX = w_pos.x, nextY = w_pos.y;
  const guides: SmartGuideData = {};

  if (bestNextX !== undefined) {
    nextX = bestNextX;
    guides.x = bestGuideX;
    if (bestIsBirthX) guides.isBirthX = true;
  }

  if (bestNextY !== undefined) {
    nextY = bestNextY;
    guides.y = bestGuideY;
    if (bestIsBirthY) guides.isBirthY = true;
  }

  return { x: nextX, y: nextY, smartguides: Object.keys(guides).length ? guides : null };
}

/**
 * Edge-level snapping for resize operations.
 *
 * Unlike `snapRect` which snaps the whole rect by center/edges (for move),
 * `snapEdge` only snaps the **actively dragged edge(s)** to nearby target
 * edges. This is essential for resize handles where the user expects:
 *   - Dragging the right handle → right edge snaps to canvas right / layer edges
 *   - Dragging the SE corner → both right and bottom edges snap independently
 *
 * Returns an adjusted rect (with the active edge(s) snapped) + smart guide data.
 */
export function snapEdge(
  rect: Rect,
  handle: string,
  frame: Frame,
  options: { threshold?: number } & SnapFilterOptions = {}
): { rect: Rect, smartguides: SmartGuideData | null } {
  const cameraScale = frame.camera?.k || 1;
  const threshold = (options.threshold ?? 15) / cameraScale;

  // Determine which edges are active based on handle
  const snapX = handle.includes('e') ? 'right' : handle.includes('w') ? 'left' : null;
  const snapY = handle.includes('s') ? 'bottom' : handle.includes('n') ? 'top' : null;

  // Build target edge positions in canvas-local coordinates
  const { w: cw, h: ch } = frame.canvas;
  const targetXs: number[] = [];
  const targetYs: number[] = [];

  // Canvas edges
  if (options.snapToCanvas !== false) {
    targetXs.push(0, cw / 2, cw);
    targetYs.push(0, ch / 2, ch);
  }

  // Layer edges
  if (options.snapToLayers !== false) {
    const layerTargets = frame.layers.order
      .map(id => frame.layers.byId[id])
      .filter(l => l.visible && l.role === 'host' && !l.locked)
      .slice(0, options.maxSnapTargets || 8);

    for (const l of layerTargets) {
      const vr = l.visibleShape?.rect || { x: 0, y: 0, w: l.bounding.w, h: l.bounding.h };
      // Use full world matrix to compute visible area AABB (handles rotation correctly)
      const wm = getLayerWorldMatrix(l);
      const corners = [
        wm.apply({ x: vr.x, y: vr.y }),
        wm.apply({ x: vr.x + vr.w, y: vr.y }),
        wm.apply({ x: vr.x, y: vr.y + vr.h }),
        wm.apply({ x: vr.x + vr.w, y: vr.y + vr.h }),
      ];
      const minX = Math.min(corners[0].x, corners[1].x, corners[2].x, corners[3].x) + cw / 2;
      const maxX = Math.max(corners[0].x, corners[1].x, corners[2].x, corners[3].x) + cw / 2;
      const minY = Math.min(corners[0].y, corners[1].y, corners[2].y, corners[3].y) + ch / 2;
      const maxY = Math.max(corners[0].y, corners[1].y, corners[2].y, corners[3].y) + ch / 2;
      targetXs.push(minX, (minX + maxX) / 2, maxX);
      targetYs.push(minY, (minY + maxY) / 2, maxY);
    }
  }

  const guides: SmartGuideData = {};
  let newRect = { ...rect };

  // Snap X edge
  if (snapX) {
    const activeEdgeX = snapX === 'right' ? rect.x + rect.w : rect.x;
    let bestDiff = threshold;
    let bestTarget: number | undefined;

    for (const tx of targetXs) {
      const diff = Math.abs(activeEdgeX - tx);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestTarget = tx;
      }
    }

    if (bestTarget !== undefined) {
      if (snapX === 'right') {
        newRect = { ...newRect, w: bestTarget - newRect.x };
      } else {
        const oldRight = newRect.x + newRect.w;
        newRect = { ...newRect, x: bestTarget, w: oldRight - bestTarget };
      }
      guides.x = bestTarget - cw / 2; // Convert to world-space for guide rendering
    }
  }

  // Snap Y edge
  if (snapY) {
    const activeEdgeY = snapY === 'bottom' ? rect.y + rect.h : rect.y;
    let bestDiff = threshold;
    let bestTarget: number | undefined;

    for (const ty of targetYs) {
      const diff = Math.abs(activeEdgeY - ty);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestTarget = ty;
      }
    }

    if (bestTarget !== undefined) {
      if (snapY === 'bottom') {
        newRect = { ...newRect, h: bestTarget - newRect.y };
      } else {
        const oldBottom = newRect.y + newRect.h;
        newRect = { ...newRect, y: bestTarget, h: oldBottom - bestTarget };
      }
      guides.y = bestTarget - ch / 2; // Convert to world-space for guide rendering
    }
  }

  const smartguides = Object.keys(guides).length ? guides : null;
  return { rect: newRect, smartguides };
}

/**
 * Snap a rectangle under the world coordinate system to the canvas local physical pixel grid (Snap world rectangle boundaries to canvas physical pixel grid)
 */
export function snapRectToPixel(
  targetRect: WorldRect,
  canvasDim: Dimensions,
  strategy: 'round' | 'floor' | 'ceil' = 'round'
): WorldRect {
  const fn = Math[strategy];

  // 1. Project bounding box in world coordinates to canvas local relative coordinate space
  const localRect = worldToLocalRect(targetRect, canvasDim);

  // 2. Perform whole pixel alignment on the top-left boundary (x, y) in canvas local space
  const localRectAligned = asLocalRect({
    x: fn(localRect.x),
    y: fn(localRect.y),
    w: localRect.w,
    h: localRect.h
  });

  // 3. Project the aligned local space rectangle back to the world coordinate system
  return localToWorldRect(localRectAligned, canvasDim);
}
