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
 * TextOverlay orientation-aware resize — math invariant suite.
 *
 * TextOverlay's `createTextResizeHandler` opts into the same local-axes resize
 * path as MarkerOverlay (see `core/geometry/orientation-resize.test.ts` for the
 * framework-level proof). This suite additionally guards the TEXT-SPECIFIC
 * behaviour: text floors the resized box at `minW = 40` and a font-derived
 * `minH` (interactions.ts onUpdate), so we only assert anchor invariance for
 * drags that keep both dimensions above the floor.
 *
 * THE INVARIANT: while dragging a resize handle, the OPPOSITE (anchor) corner
 * must stay pinned in world space, for every rotation / flip / handle.
 */

import { describe, it, expect } from 'vitest';
import { Matrix3x3 } from '@opengpex/editor/core/geometry/matrix';

type Flip = { h: boolean; v: boolean };

/** R × F — must match core getOrientationMatrix / TransformHandler buildOrientationMatrix. */
function orientationMatrix(rotation: number, flip: Flip): Matrix3x3 {
  const R = Matrix3x3.rotate(rotation);
  const F = new Matrix3x3(flip.h ? -1 : 1, 0, 0, flip.v ? -1 : 1, 0, 0);
  return R.multiply(F);
}

/** Project a bounding-local point into world space (mirrors computeWorldMatrix). */
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
 * Simulate one text resize drag through the production pipeline (TransformHandler
 * orientation branch + createTextResizeHandler.onUpdate), applying the text
 * min-size floor exactly as the handler does.
 */
function simulateTextResize(opts: {
  rotation: number;
  flip: Flip;
  handle: string;
  canvasDelta: { x: number; y: number };
  bounding: { w: number; h: number };
  centre: { cx: number; cy: number };
  fontSize?: number;
  lineHeight?: number;
}) {
  const { rotation, flip, handle, canvasDelta, bounding, centre } = opts;
  const O = orientationMatrix(rotation, flip);
  const Oinv = O.inverse();

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

  // Text-specific min-size floor (createTextResizeHandler.onUpdate).
  const minW = 40;
  const minH = Math.max(20, (opts.fontSize ?? 24) * (opts.lineHeight ?? 1.4));
  const finalW = Math.max(minW, resized.w);
  const finalH = Math.max(minH, resized.h);

  const oldLocalC = { x: startLocal.x + startLocal.w / 2, y: startLocal.y + startLocal.h / 2 };
  const newLocalC = { x: resized.x + finalW / 2, y: resized.y + finalH / 2 };
  const worldOffset = O.apply({ x: newLocalC.x - oldLocalC.x, y: newLocalC.y - oldLocalC.y });
  const newCentre = { cx: centre.cx + worldOffset.x, cy: centre.cy + worldOffset.y };

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
// Growth-only deltas so the box never hits the min-size floor (which would
// legitimately move the anchor and is a separate, expected behaviour).
const DELTAS = [
  { x: 60, y: 50 },
  { x: -55, y: 45 },
  { x: 0, y: 80 },
  { x: -70, y: -60 },
];

describe('text orientation-aware resize', () => {
  it('keeps the anchor corner pinned in world space for every rotation/flip/handle (above min-size)', () => {
    // Start well above the min floor so growth-only drags stay unclamped.
    const bounding = { w: 240, h: 160 };
    const centre = { cx: 0, cy: 0 };
    const minH = Math.max(20, 24 * 1.4);
    const failures: string[] = [];

    for (const rotation of ROTATIONS) {
      for (const flip of FLIPS) {
        for (const handle of HANDLES) {
          for (const canvasDelta of DELTAS) {
            const r = simulateTextResize({ rotation, flip, handle, canvasDelta, bounding, centre });
            // Only assert invariance where neither dimension was floored.
            if (r.finalW <= 40 || r.finalH <= minH) continue;
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

  it('grows the local width along the layer axis after a 90° canvas rotation (the original bug)', () => {
    const bounding = { w: 240, h: 160 };
    const centre = { cx: 0, cy: 0 };
    const noFlip: Flip = { h: false, v: false };

    // Unrotated: dragging 'e' needs a canvas +x delta to widen.
    const flat = simulateTextResize({
      rotation: 0, flip: noFlip, handle: 'e',
      canvasDelta: { x: 40, y: 0 }, bounding, centre,
    });
    expect(flat.finalW).toBe(280);
    expect(flat.finalH).toBe(160);

    // Rotated 90°: local +x now points along canvas +y, so a canvas +y drag must
    // widen it. Before the fix the handler consumed canvas dx (= 0), so the text
    // box would not resize.
    const rotated = simulateTextResize({
      rotation: 90, flip: noFlip, handle: 'e',
      canvasDelta: { x: 0, y: 40 }, bounding, centre,
    });
    expect(rotated.finalW).toBe(280);
    expect(rotated.finalH).toBe(160);
  });

  it('locks the perpendicular dimension for single-axis edge handles', () => {
    const bounding = { w: 240, h: 160 };
    const centre = { cx: 0, cy: 0 };
    const noFlip: Flip = { h: false, v: false };

    const e = simulateTextResize({
      rotation: 90, flip: noFlip, handle: 'e',
      canvasDelta: { x: 33, y: 50 }, bounding, centre,
    });
    expect(e.finalH).toBe(160);

    const n = simulateTextResize({
      rotation: 90, flip: noFlip, handle: 'n',
      canvasDelta: { x: 33, y: 50 }, bounding, centre,
    });
    expect(n.finalW).toBe(240);
  });
});
