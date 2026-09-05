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
import { CameraState, Dimensions, Frame, Layer, WorldPoint, Rect, asWorldPoint, Point2D, WorldRect, asLocalRect } from '@opengpex/editor/core/types';
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
  const { targetXs, targetYs } = collectEdgeSnapTargets(frame, options);

  const guides: SmartGuideData = {};
  let newRect = { ...rect };

  // Snap X edge
  if (snapX) {
    const activeEdgeX = snapX === 'right' ? rect.x + rect.w : rect.x;
    const bestTarget = findNearestTarget(activeEdgeX, targetXs, threshold);

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
    const bestTarget = findNearestTarget(activeEdgeY, targetYs, threshold);

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
 * RotatedEdgePose: the world-space pose needed to project a LOCAL-axes rect back
 * into canvas space for rotation-aware edge snapping.
 *
 * `TransformHandler`'s orientation branch runs its resize math in the object's
 * OWN axes, where the rect is axis-aligned by definition. To snap against canvas
 * edges / centre lines / other layers we must first project that local rect into
 * canvas space, which needs the object's rotation/flip PLUS the world centre the
 * local rect is anchored to.
 *
 * Supplied by the framework, which gets rotation/flip/cx/cy from the consumer's
 * `getOrientation` callback (see `LayerOrientation`).
 */
export interface RotatedEdgePose {
  /** Rotation in degrees (layer.rotation) */
  rotation: number;
  /** Mirror flags (layer.flip) */
  flip: { h: boolean; v: boolean };
  /** World-space centre of the object's bounding box at gesture START. */
  startCenter: { cx: number; cy: number };
  /** The LOCAL-axes rect at gesture START (whose centre maps to startCenter). */
  startLocalRect: Rect;
}

/**
 * Build the orientation (rotation + mirror) matrix for a pose.
 *
 * MUST stay sign-compatible with `getOrientationMatrix` in `./transform.ts`
 * (R × F, rotation in degrees), which is what `computeWorldMatrix` (rendering)
 * and `computeLayerMovePose` (move) use. If these disagree the snap direction
 * would be mirrored relative to what the user sees on screen.
 */
function buildPoseMatrix(pose: { rotation: number; flip: { h: boolean; v: boolean } }): Matrix3x3 {
  const R = Matrix3x3.rotate(pose.rotation);
  const F = new Matrix3x3(pose.flip?.h ? -1 : 1, 0, 0, pose.flip?.v ? -1 : 1, 0, 0);
  return R.multiply(F);
}

/**
 * Rotation-aware edge snapping for resize on rotated/mirrored objects.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Plain `snapEdge` compares CANVAS-axis edges. For a rotated object the resize
 * math runs in the object's LOCAL axes, so its "right edge" is a slanted line in
 * canvas space and has no canvas-axis coordinate to compare against.
 *
 * ── Snapping semantics (AABB projection, Figma/Sketch model) ─────────────────
 * We snap the object's world-space **axis-aligned bounding box (AABB)** edges,
 * not the (slanted) true edges:
 *
 *   1. Project the 4 corners of the current LOCAL rect into canvas space.
 *   2. Take their AABB.
 *   3. Determine which AABB edges are "active" — which AABB sides the dragged
 *      handle pushes outward, by projecting the handle's local outward direction
 *      through the orientation matrix.
 *   4. Snap those active AABB edges to the SAME targets plain `snapEdge` uses
 *      (shared via `collectEdgeSnapTargets`).
 *   5. Map the canvas-space correction back through O⁻¹ into local space and
 *      apply it to the local rect's dragged edge(s).
 *
 * This is well-defined at every angle (including 45°, where "slanted edge onto a
 * vertical line" has no solution), and because AABB edges are always H/V the
 * guide lines stay plain full-screen H/V lines — so `SmartGuideData { x?, y? }`
 * and the existing SmartGuides renderer need no changes.
 *
 * @param localRect - The CURRENT local-axes rect produced by the resize math.
 * @param handle    - Resize handle ('n'|'s'|'e'|'w'|'nw'|'ne'|'sw'|'se').
 * @param pose      - World pose (rotation/flip + start centre + start local rect).
 * @param frame     - Active frame (canvas dims, layers, camera for threshold).
 * @returns The corrected LOCAL rect + smart guide data (world-space H/V lines).
 *
 * Returns `localRect` untouched (and `smartguides: null`) when nothing is within
 * the snap threshold, so callers can use the result unconditionally.
 */
export function snapEdgeRotated(
  localRect: Rect,
  handle: string,
  pose: RotatedEdgePose,
  frame: Frame,
  options: { threshold?: number } & SnapFilterOptions = {}
): { rect: Rect, smartguides: SmartGuideData | null } {
  const cameraScale = frame.camera?.k || 1;
  const threshold = (options.threshold ?? 15) / cameraScale;
  const { w: cw, h: ch } = frame.canvas;

  const O = buildPoseMatrix(pose);

  // ── 1. Project the current local rect into canvas space ────────────────────
  // Local→world: worldPoint = startCenter + O × (localPoint − startLocalCentre).
  // Canvas-local adds the (cw/2, ch/2) origin shift, matching the target set.
  const startLocalCx = pose.startLocalRect.x + pose.startLocalRect.w / 2;
  const startLocalCy = pose.startLocalRect.y + pose.startLocalRect.h / 2;

  const localToCanvas = (lx: number, ly: number): Point2D => {
    const rotated = O.apply({ x: lx - startLocalCx, y: ly - startLocalCy });
    return {
      x: pose.startCenter.cx + rotated.x + cw / 2,
      y: pose.startCenter.cy + rotated.y + ch / 2,
    };
  };

  const corners = [
    localToCanvas(localRect.x, localRect.y),
    localToCanvas(localRect.x + localRect.w, localRect.y),
    localToCanvas(localRect.x, localRect.y + localRect.h),
    localToCanvas(localRect.x + localRect.w, localRect.y + localRect.h),
  ];

  const aabbLeft = Math.min(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
  const aabbRight = Math.max(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
  const aabbTop = Math.min(corners[0].y, corners[1].y, corners[2].y, corners[3].y);
  const aabbBottom = Math.max(corners[0].y, corners[1].y, corners[2].y, corners[3].y);

  // ── 2. Which AABB edges does the dragged handle push? ──────────────────────
  // Resize only moves the dragged LOCAL edge(s). Growing local axis A by 1 unit
  // displaces the two corners on that edge by `unitA` in canvas space, so the
  // dragged corner's canvas motion is the sum over the handle's local axes.
  // The AABB side it leads is simply the side it moves toward.
  const localDirX = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
  const localDirY = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;

  // Canvas displacement of a point when its LOCAL x (resp. y) increases by 1.
  const unitX = O.apply({ x: 1, y: 0 });
  const unitY = O.apply({ x: 0, y: 1 });

  // Sub-pixel projections are rotation noise (e.g. cos(90°) ≈ 6e-17), not intent.
  const DIR_EPSILON = 1e-6;

  // Canvas-space displacement of the DRAGGED corner per unit of local growth.
  const dragDispX = unitX.x * localDirX + unitY.x * localDirY;
  const dragDispY = unitX.y * localDirX + unitY.y * localDirY;

  // The dragged corner leads an AABB side only if it moves that way.
  const activeX: 'left' | 'right' | null =
    dragDispX > DIR_EPSILON ? 'right' : dragDispX < -DIR_EPSILON ? 'left' : null;
  const activeY: 'top' | 'bottom' | null =
    dragDispY > DIR_EPSILON ? 'bottom' : dragDispY < -DIR_EPSILON ? 'top' : null;

  if (!activeX && !activeY) {
    return { rect: localRect, smartguides: null };
  }

  // ── 3. Snap targets (shared with the canvas-axis snapEdge) ─────────────────
  const { targetXs, targetYs } = collectEdgeSnapTargets(frame, options);

  // ── 4. Nearest target per active AABB edge → canvas-space correction ───────
  const guides: SmartGuideData = {};
  let correctX = 0;
  let correctY = 0;

  if (activeX) {
    const edgeValue = activeX === 'right' ? aabbRight : aabbLeft;
    const target = findNearestTarget(edgeValue, targetXs, threshold);
    if (target !== undefined) {
      correctX = target - edgeValue;
      guides.x = target - cw / 2; // Convert to world-space for guide rendering
    }
  }

  if (activeY) {
    const edgeValue = activeY === 'bottom' ? aabbBottom : aabbTop;
    const target = findNearestTarget(edgeValue, targetYs, threshold);
    if (target !== undefined) {
      correctY = target - edgeValue;
      guides.y = target - ch / 2; // Convert to world-space for guide rendering
    }
  }

  if (correctX === 0 && correctY === 0) {
    return { rect: localRect, smartguides: null };
  }

  // ── 5. Solve for the local size deltas that land the AABB edge on target ───
  // Growing local axis A by δ displaces the dragged corner by δ × unitA (canvas).
  // To land the active AABB edge exactly on its target we invert that scalar.
  //
  // A local axis can drive BOTH canvas axes (e.g. at 45° each contributes 1/√2).
  // When a snap was found on only one canvas axis we must solve against THAT
  // axis; when both snapped we prefer the component this local axis dominates
  // (largest |gradient|), which is also the correct tie-break at 45°.
  const solveDelta = (unit: Point2D, axisDir: number): number => {
    if (axisDir === 0) return 0;
    const gx = unit.x * axisDir;
    const gy = unit.y * axisDir;
    const canX = correctX !== 0 && Math.abs(gx) > DIR_EPSILON;
    const canY = correctY !== 0 && Math.abs(gy) > DIR_EPSILON;

    if (canX && canY) return Math.abs(gx) >= Math.abs(gy) ? correctX / gx : correctY / gy;
    if (canX) return correctX / gx;
    if (canY) return correctY / gy;
    return 0;
  };

  const deltaLocalX = solveDelta(unitX, localDirX);
  const deltaLocalY = solveDelta(unitY, localDirY);

  if (deltaLocalX === 0 && deltaLocalY === 0) {
    return { rect: localRect, smartguides: null };
  }

  // Apply the growth to the dragged edge(s) only — the anchored edge stays fixed,
  // exactly like plain snapEdge does in canvas space.
  let nextRect = { ...localRect };

  if (deltaLocalX !== 0) {
    if (localDirX > 0) {
      // 'e' side dragged → adjust width, keep the local left edge fixed.
      nextRect = { ...nextRect, w: nextRect.w + deltaLocalX };
    } else {
      // 'w' side dragged → move the local left edge, keep the right edge fixed.
      nextRect = { ...nextRect, x: nextRect.x - deltaLocalX, w: nextRect.w + deltaLocalX };
    }
  }

  if (deltaLocalY !== 0) {
    if (localDirY > 0) {
      // 's' side dragged → adjust height, keep the local top edge fixed.
      nextRect = { ...nextRect, h: nextRect.h + deltaLocalY };
    } else {
      // 'n' side dragged → move the local top edge, keep the bottom edge fixed.
      nextRect = { ...nextRect, y: nextRect.y - deltaLocalY, h: nextRect.h + deltaLocalY };
    }
  }

  const smartguides = Object.keys(guides).length ? guides : null;
  return { rect: nextRect, smartguides };
}

/**
 * Collect canvas-local edge snap target positions (X and Y candidate lines).
 *
 * Extracted so `snapEdge` (canvas axes) and `snapEdgeRotated` (rotated AABB)
 * share ONE definition of "what counts as a snap target": canvas edges + centre
 * lines, plus each eligible layer's world AABB edges + centre.
 */
function collectEdgeSnapTargets(
  frame: Frame,
  options: SnapFilterOptions
): { targetXs: number[], targetYs: number[] } {
  const { w: cw, h: ch } = frame.canvas;
  const targetXs: number[] = [];
  const targetYs: number[] = [];

  // Canvas edges + centre lines
  if (options.snapToCanvas !== false) {
    targetXs.push(0, cw / 2, cw);
    targetYs.push(0, ch / 2, ch);
  }

  // Layer edges (world AABB, so rotated layers are handled correctly)
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

  return { targetXs, targetYs };
}

/**
 * Pick the nearest snap target within `threshold`, or undefined if none qualify.
 */
function findNearestTarget(value: number, targets: number[], threshold: number): number | undefined {
  let bestDiff = threshold;
  let best: number | undefined;
  for (const t of targets) {
    const diff = Math.abs(value - t);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = t;
    }
  }
  return best;
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

// ─── Canvas Viewport Pixel-Snap ──────────────────────────────────────────────

/**
 * Result of pixel-snap computation for canvas viewport boundaries.
 * Provides both physical pixel coordinates (for Canvas 2D operations)
 * and CSS pixel coordinates (for SVG/DOM positioning).
 */
export interface SnappedCanvasRect {
  /** Physical pixel coordinates (for artboardClip, Canvas ctx operations) */
  physical: { x: number; y: number; w: number; h: number };
  /** CSS pixel coordinates (for SVG polygon, DOM element positioning) */
  css: { x: number; y: number; w: number; h: number };
  /** Adjusted per-axis render scale factors (physical pixels per canvas pixel, includes DPR) */
  renderScale: { x: number; y: number };
}

/**
 * Computes pixel-snapped canvas boundary coordinates for viewport rendering.
 *
 * When the viewport zoom factor (cam.k) is a non-integer value, the canvas
 * boundary in screen space lands at fractional pixel positions. This causes:
 *   1. Anti-aliased clip edges (ctx.clip with sub-pixel rect) → ghost lines during pan
 *   2. SVG polygon edges at sub-pixel positions → backdrop/content misalignment
 *   3. Visible 1px checkerboard bleed at canvas boundaries
 *
 * This function snaps both the origin (top-left) and the far edge (bottom-right)
 * of the canvas to the nearest integer physical pixel, ensuring:
 *   - ctx.clip() boundary is at integer pixels → no anti-aliased semi-transparent edge
 *   - SVG polygon boundary aligns with canvas clip → no checkerboard bleed
 *   - Fill layers / images fill exactly to the integer boundary → no transparent gaps
 *
 * The render scale is adjusted by a tiny amount (typically < 0.01%) to accommodate
 * the rounding. This is visually imperceptible.
 *
 * @param cam - Current camera state (position + zoom)
 * @param canvas - Canvas logical dimensions (width × height in canvas pixels)
 * @param dpr - Device pixel ratio (window.devicePixelRatio)
 *
 */
export function snapCanvasRect(
  cam: CameraState,
  canvas: Dimensions,
  dpr: number,
): SnappedCanvasRect {
  // Snap origin and far edge independently to nearest integer physical pixel
  const rawX = cam.x * dpr;
  const rawY = cam.y * dpr;
  const rawRight = (cam.x + canvas.w * cam.k) * dpr;
  const rawBottom = (cam.y + canvas.h * cam.k) * dpr;

  const snapX = Math.round(rawX);
  const snapY = Math.round(rawY);
  const snapRight = Math.round(rawRight);
  const snapBottom = Math.round(rawBottom);

  const snapW = snapRight - snapX;
  const snapH = snapBottom - snapY;

  // Derive CSS coordinates (may be x.5 for odd physical pixels at dpr=2, which is fine —
  // the browser will rasterize SVG at physical pixel boundaries correctly)
  const cssX = snapX / dpr;
  const cssY = snapY / dpr;
  const cssW = snapW / dpr;
  const cssH = snapH / dpr;

  // Compute adjusted render scale so that canvas-local coordinates map to
  // snapped physical pixel dimensions exactly.
  const renderScaleX = canvas.w > 0 ? snapW / canvas.w : dpr;
  const renderScaleY = canvas.h > 0 ? snapH / canvas.h : dpr;

  return {
    physical: { x: snapX, y: snapY, w: snapW, h: snapH },
    css: { x: cssX, y: cssY, w: cssW, h: cssH },
    renderScale: { x: renderScaleX, y: renderScaleY },
  };
}
