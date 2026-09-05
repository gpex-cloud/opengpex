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

/**
 * Orientation-aware resize — math invariant suite.
 *
 * Guards the local-axes resize path added to `TransformHandler` for objects that
 * carry a non-zero `layer.rotation` (e.g. a marker after a canvas Rotate
 * Left/Right, where `transformFrame` bumps `rotation` but leaves `bounding`
 * untouched — see `core/geometry/operators/transform.ts`).
 *
 * THE INVARIANT: while dragging a resize handle, the OPPOSITE (anchor) corner
 * must stay pinned in world space, for every rotation / flip / handle. This is
 * exactly what broke before the fix: the resize math consumed canvas-axis
 * deltas, so on a rotated marker the handle grew the wrong dimension.
 *
 * The helpers below mirror the production formulas:
 *   - orientation matrix       → `buildOrientationMatrix` (TransformHandler) and
 *                                `getOrientationMatrix` (core transform.ts): R × F
 *   - anchor/handle selection  → the orientation branch of `TransformHandler.onMove`
 *   - rect math                → `calculateResizedRect` (operators/space.ts)
 *   - centre write-back        → `createMarkerResizeHandler.onUpdate`
 */

import { describe, it, expect } from 'vitest';
import { Matrix3x3 } from './matrix';

type Flip = { h: boolean; v: boolean };

/** R × F — must match core getOrientationMatrix / TransformHandler buildOrientationMatrix. */
function orientationMatrix(rotation: number, flip: Flip): Matrix3x3 {
  const R = Matrix3x3.rotate(rotation);
  const F = new Matrix3x3(flip.h ? -1 : 1, 0, 0, flip.v ? -1 : 1, 0, 0);
  return R.multiply(F);
}

/**
 * Project a point given in bounding-local coords (origin = bounding top-left)
 * into world space, mirroring computeWorldMatrix's
 * Translate(cx,cy) × Orientation × Translate(-w/2,-h/2).
 */
function localToWorld(
  centre: { cx: number; cy: number },
  bounding: { w: number; h: number },
  O: Matrix3x3,
  p: { x: number; y: number }
) {
  const q = O.apply({ x: p.x - bounding.w / 2, y: p.y - bounding.h / 2 });
  return { x: centre.cx + q.x, y: centre.cy + q.y };
}

/** Mirrors calculateResizedRect (operators/space.ts) — coordinate-system agnostic. */
function calcResizedRect(
  cur: { x: number; y: number },
  anchor: { x: number; y: number },
  dragType: string,
  startDim: { w: number; h: number }
) {
  const isEdge = ['n', 's', 'e', 'w'].includes(dragType);
  let dw = Math.abs(cur.x - anchor.x);
  let dh = Math.abs(cur.y - anchor.y);
  if (isEdge) {
    if (dragType === 'n' || dragType === 's') dw = startDim.w;
    if (dragType === 'w' || dragType === 'e') dh = startDim.h;
  }
  return { x: Math.min(anchor.x, cur.x), y: Math.min(anchor.y, cur.y), w: dw, h: dh };
}

/**
 * Run one simulated drag through the orientation-aware pipeline and report where
 * the anchor corner ended up (before vs after).
 */
function simulateResize(opts: {
  rotation: number;
  flip: Flip;
  handle: string;
  canvasDelta: { x: number; y: number };
  bounding: { w: number; h: number };
  centre: { cx: number; cy: number };
}) {
  const { rotation, flip, handle, canvasDelta, bounding, centre } = opts;
  const O = orientationMatrix(rotation, flip);
  const Oinv = O.inverse();

  // getInitialState (rotated marker) returns the local-axes rect (0,0,w,h).
  const startLocal = { x: 0, y: 0, w: bounding.w, h: bounding.h };

  const addressesX = handle.includes('w') || handle.includes('e');
  const addressesY = handle.includes('n') || handle.includes('s');

  const anchorX = handle.includes('w') ? startLocal.x + startLocal.w : startLocal.x;
  const anchorY = handle.includes('n') ? startLocal.y + startLocal.h : startLocal.y;
  const handleX = addressesX
    ? (handle.includes('w') ? startLocal.x : startLocal.x + startLocal.w)
    : anchorX;
  const handleY = addressesY
    ? (handle.includes('n') ? startLocal.y : startLocal.y + startLocal.h)
    : anchorY;

  const anchorWorldBefore = localToWorld(centre, bounding, O, { x: anchorX, y: anchorY });

  // Pointer delta: canvas axes → local axes.
  const ld = Oinv.apply(canvasDelta);
  const isHorizontalEdge = handle === 'e' || handle === 'w';
  const isVerticalEdge = handle === 'n' || handle === 's';
  const ldx = isVerticalEdge ? 0 : ld.x;
  const ldy = isHorizontalEdge ? 0 : ld.y;

  const resized = calcResizedRect(
    { x: handleX + (addressesX ? ldx : 0), y: handleY + (addressesY ? ldy : 0) },
    { x: anchorX, y: anchorY },
    handle,
    { w: startLocal.w, h: startLocal.h }
  );

  const finalW = Math.max(8, resized.w);
  const finalH = Math.max(8, resized.h);

  // onUpdate: rotate the local centre delta into world space.
  const oldLocalC = { x: startLocal.x + startLocal.w / 2, y: startLocal.y + startLocal.h / 2 };
  const newLocalC = { x: resized.x + finalW / 2, y: resized.y + finalH / 2 };
  const worldOffset = O.apply({ x: newLocalC.x - oldLocalC.x, y: newLocalC.y - oldLocalC.y });
  const newCentre = { cx: centre.cx + worldOffset.x, cy: centre.cy + worldOffset.y };

  // After the write-back the bounding IS the new rect, so local coords re-base to
  // its top-left: the anchor sits at 0 or w/h.
  const anchorLocalAfter = {
    x: addressesX ? (handle.includes('w') ? finalW : 0) : 0,
    y: addressesY ? (handle.includes('n') ? finalH : 0) : 0,
  };
  const anchorWorldAfter = localToWorld(newCentre, { w: finalW, h: finalH }, O, anchorLocalAfter);

  return {
    finalW,
    finalH,
    drift: Math.hypot(
      anchorWorldAfter.x - anchorWorldBefore.x,
      anchorWorldAfter.y - anchorWorldBefore.y
    ),
  };
}

const HANDLES = ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'];
const ROTATIONS = [0, 90, 180, 270, 37];
const FLIPS: Flip[] = [
  { h: false, v: false },
  { h: true, v: false },
  { h: false, v: true },
];
const DELTAS = [
  { x: 30, y: 20 },
  { x: -25, y: 15 },
  { x: 0, y: 40 },
  { x: -40, y: -30 },
];

describe('orientation-aware resize', () => {
  it('keeps the anchor corner pinned in world space for every rotation/flip/handle', () => {
    const bounding = { w: 200, h: 100 };
    const centre = { cx: 0, cy: 0 };
    const failures: string[] = [];

    for (const rotation of ROTATIONS) {
      for (const flip of FLIPS) {
        for (const handle of HANDLES) {
          for (const canvasDelta of DELTAS) {
            const r = simulateResize({ rotation, flip, handle, canvasDelta, bounding, centre });
            if (r.drift > 1e-6) {
              failures.push(
                `rot=${rotation} flip=${JSON.stringify(flip)} handle=${handle} ` +
                `delta=${JSON.stringify(canvasDelta)} drift=${r.drift}`
              );
            }
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('grows the local width along the layer axis, not the canvas axis (the original bug)', () => {
    const bounding = { w: 200, h: 100 };
    const centre = { cx: 0, cy: 0 };
    const noFlip: Flip = { h: false, v: false };

    // Unrotated: dragging 'e' needs a canvas +x delta to widen.
    const flat = simulateResize({
      rotation: 0, flip: noFlip, handle: 'e',
      canvasDelta: { x: 40, y: 0 }, bounding, centre,
    });
    expect(flat.finalW).toBe(240);
    expect(flat.finalH).toBe(100);

    // Rotated 90°: the layer's local +x now points along canvas +y, so a canvas
    // +y drag must widen it by the same amount. Before the fix the handler used
    // the canvas dx (= 0 here), so the marker would not resize correctly.
    const rotated = simulateResize({
      rotation: 90, flip: noFlip, handle: 'e',
      canvasDelta: { x: 0, y: 40 }, bounding, centre,
    });
    expect(rotated.finalW).toBe(240);
    expect(rotated.finalH).toBe(100);
  });

  it('locks the perpendicular dimension for single-axis edge handles', () => {
    const bounding = { w: 200, h: 100 };
    const centre = { cx: 0, cy: 0 };
    const noFlip: Flip = { h: false, v: false };

    // 'e' only changes width, even with a diagonal pointer delta.
    const e = simulateResize({
      rotation: 90, flip: noFlip, handle: 'e',
      canvasDelta: { x: 33, y: 40 }, bounding, centre,
    });
    expect(e.finalH).toBe(100);

    // 'n' only changes height.
    const n = simulateResize({
      rotation: 90, flip: noFlip, handle: 'n',
      canvasDelta: { x: 33, y: 40 }, bounding, centre,
    });
    expect(n.finalW).toBe(200);
  });

  it('matches the core orientation convention (R x F) used by the renderer', () => {
    // A 90 degree rotation maps local +x to world +y (same as Matrix3x3.rotate90(1)).
    const O = orientationMatrix(90, { h: false, v: false });
    const mapped = O.apply({ x: 1, y: 0 });
    expect(mapped.x).toBeCloseTo(0, 10);
    expect(mapped.y).toBeCloseTo(1, 10);

    // Sign-compatibility with the D4 fast path used by transformFrame.
    const d4 = Matrix3x3.rotate90(1);
    expect(O.a).toBeCloseTo(d4.a, 10);
    expect(O.b).toBeCloseTo(d4.b, 10);
    expect(O.c).toBeCloseTo(d4.c, 10);
    expect(O.d).toBeCloseTo(d4.d, 10);
  });
});
