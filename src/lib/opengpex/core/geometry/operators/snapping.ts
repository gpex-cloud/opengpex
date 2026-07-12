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
import { Dimensions, Frame, WorldPoint, Rect, asWorldPoint, Point2D, WorldRect, asLocalRect } from '@opengpex/editor/core/types';
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
 * Calculate snapped coordinates
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
  // 💡 1. Dynamic alignment threshold: constant screen pixel visual snapping hot zone, ensuring extremely fine pixel-level tuning when zoomed in
  const dynamicThreshold = threshold / cameraScale;

  let [nextX, nextY] = [w_pos.x, w_pos.y];
  const guides: SmartGuideData = {};

  interface SnappableSource {
    matrix: Matrix3x3;
    size: Dimensions;
    type: 'canvas' | 'birth' | 'layer';
  }

  const activeLayer = activeLayerId ? frame.layers.byId[activeLayerId] : null;

  // 💡 2. Build snappables with config-driven filtering
  const snappables: SnappableSource[] = [];

  // Canvas (configurable)
  if (filterOptions.snapToCanvas !== false) {
    snappables.push({ matrix: Matrix3x3.identity(), size: frame.canvas, type: 'canvas' });
  }

  // Birth position (configurable)
  if (filterOptions.snapToBirth !== false && activeLayer?.birthCenter) {
    snappables.push({
      matrix: Matrix3x3.translate(activeLayer.birthCenter.cx, activeLayer.birthCenter.cy),
      size: { w: 0, h: 0 } as Dimensions,
      type: 'birth' as const
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
      const rect = l.visibleShape?.rect || { x: 0, y: 0, w: l.bounding.w, h: l.bounding.h };
      snappables.push({
        matrix: getLayerWorldMatrix(l).multiply(Matrix3x3.translate(rect.x + rect.w / 2, rect.y + rect.h / 2)),
        size: { w: rect.w, h: rect.h } as Dimensions,
        type: 'layer' as const
      });
    }
  }

  const [dw, dh] = [targetDim.w / 2, targetDim.h / 2];
  // 💡 Adjust alignment axis order: put center point 0 first, making center alignment hit first under equal deviation
  const dOX = targetDim.w === 0 ? [0] : [0, -dw, dw];
  const dOY = targetDim.h === 0 ? [0] : [0, -dh, dh];

  // 💡 3. Optimal snapping deviation alignment: find snapping targets with minimum absolute deviations on X and Y axes separately, avoiding jumpiness caused by abrupt breaks
  let bestDiffX = dynamicThreshold;
  let bestNextX: number | undefined = undefined;
  let bestGuideX: number | undefined = undefined;
  let bestIsBirthX = false;

  let bestDiffY = dynamicThreshold;
  let bestNextY: number | undefined = undefined;
  let bestGuideY: number | undefined = undefined;
  let bestIsBirthY = false;

  for (const s of snappables) {
    const invM = s.matrix.inverse();
    const lp = invM.apply(w_pos);
    const [sw, sh] = [s.size.w / 2, s.size.h / 2];
    // 💡 Adjust alignment candidate axis order: put center reference point 0 first
    const tPX = s.size.w === 0 ? [0] : [0, -sw, sw];
    const tPY = s.size.h === 0 ? [0] : [0, -sh, sh];

    for (const tx of tPX) {
      for (const dx of dOX) {
        const diff = Math.abs(lp.x + dx - tx);
        // 💡 Introduce center axis preference coefficient: if it is center-to-center alignment, give a 0.8 discount to the deviation comparison, ensuring high-stability highlight lines for center alignment
        const isCenterToCenter = (dx === 0 && tx === 0);
        const evalDiff = isCenterToCenter ? diff * 0.8 : diff;

        if (evalDiff < bestDiffX) {
          bestDiffX = evalDiff;
          bestNextX = s.matrix.apply({ x: tx - dx, y: lp.y }).x;
          bestGuideX = s.matrix.apply({ x: tx, y: 0 }).x;
          bestIsBirthX = s.type === 'birth';
        }
      }
    }

    for (const ty of tPY) {
      for (const dy of dOY) {
        const diff = Math.abs(lp.y + dy - ty);
        // 💡 Similarly, introduce center-to-center alignment preference coefficient for the Y axis
        const isCenterToCenter = (dy === 0 && ty === 0);
        const evalDiff = isCenterToCenter ? diff * 0.8 : diff;

        if (evalDiff < bestDiffY) {
          bestDiffY = evalDiff;
          bestNextY = s.matrix.apply({ x: lp.x, y: ty - dy }).y;
          bestGuideY = s.matrix.apply({ x: 0, y: ty }).y;
          bestIsBirthY = s.type === 'birth';
        }
      }
    }
  }

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

  const result = { x: nextX, y: nextY, smartguides: Object.keys(guides).length ? guides : null };
  return result;
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
      // Convert layer bounding to canvas-local coords
      const lx = l.cx + cw / 2 + vr.x - vr.w / 2;
      const ly = l.cy + ch / 2 + vr.y - vr.h / 2;
      targetXs.push(lx, lx + vr.w / 2, lx + vr.w);
      targetYs.push(ly, ly + vr.h / 2, ly + vr.h);
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
