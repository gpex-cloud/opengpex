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
 * Shared orientation helpers — contract suite.
 *
 * `isRotatedPose` and `localToWorldCenter` were extracted from three/two
 * duplicated copies (framework `needsOrientationPath`, MarkerOverlay and
 * TextOverlay resize handlers). Those copies had NO cross-guard: changing the
 * sign convention in one would not fail the other's tests, producing a silently
 * mirrored resize. This suite is that guard.
 *
 * THE INVARIANT: `localToWorldCenter` must agree with the RENDERER's pose
 * convention — `computeWorldMatrix` = Translate(cx,cy) × O × Translate(-w/2,-h/2)
 * with O = R × F. It is verified here by reconstructing the world position of the
 * anchor corner independently and requiring zero drift.
 */

import { describe, it, expect } from 'vitest';
import { localToWorldCenter } from './space';
import { isRotatedPose, getOrientationMatrix } from './transform';
import { Layer, Rect } from '@opengpex/editor/core/types';

type Flip = { h: boolean; v: boolean };

const pose = (rotation: number, flip: Flip) =>
  ({ rotation, flip } as Pick<Layer, 'rotation' | 'flip'>);

describe('isRotatedPose', () => {
  it('is false only when canvas axes and local axes coincide', () => {
    expect(isRotatedPose(pose(0, { h: false, v: false }))).toBe(false);
    // 360/-360 normalise to 0 → still axis-aligned.
    expect(isRotatedPose(pose(360, { h: false, v: false }))).toBe(false);
    expect(isRotatedPose(pose(-360, { h: false, v: false }))).toBe(false);
    expect(isRotatedPose(pose(720, { h: false, v: false }))).toBe(false);
  });

  it('is true for any non-zero rotation, including negatives and non-multiples of 90', () => {
    for (const rot of [90, 180, 270, -90, 37, -37, 450, 0.5]) {
      expect(isRotatedPose(pose(rot, { h: false, v: false }))).toBe(true);
    }
  });

  it('is true for mirroring even at rotation 0', () => {
    expect(isRotatedPose(pose(0, { h: true, v: false }))).toBe(true);
    expect(isRotatedPose(pose(0, { h: false, v: true }))).toBe(true);
    expect(isRotatedPose(pose(0, { h: true, v: true }))).toBe(true);
  });

  it('tolerates a missing flip object (defensive: older layer data)', () => {
    expect(isRotatedPose({ rotation: 0 } as Pick<Layer, 'rotation' | 'flip'>)).toBe(false);
    expect(isRotatedPose({ rotation: 90 } as Pick<Layer, 'rotation' | 'flip'>)).toBe(true);
  });
});

describe('localToWorldCenter — agrees with the renderer pose convention', () => {
  const HANDLES = ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'];
  const ROTATIONS = [0, 90, 180, 270, 37, -53];
  const FLIPS: Flip[] = [
    { h: false, v: false },
    { h: true, v: false },
    { h: false, v: true },
    { h: true, v: true },
  ];

  /**
   * Independent reimplementation of the RENDERER's projection
   * (`computeWorldMatrix` = Translate(cx,cy) × O × Translate(-w/2,-h/2)):
   * bounding-local point → world.
   */
  const renderPointToWorld = (
    center: { cx: number; cy: number },
    bounding: { w: number; h: number },
    rotation: number,
    flip: Flip,
    p: { x: number; y: number }
  ) => {
    const O = getOrientationMatrix(rotation, flip);
    const q = O.apply({ x: p.x - bounding.w / 2, y: p.y - bounding.h / 2 });
    return { x: center.cx + q.x, y: center.cy + q.y };
  };

  it('keeps the anchor corner pinned in world space for every rotation × flip × handle', () => {
    const startLocalRect: Rect = { x: 0, y: 0, w: 200, h: 100 };
    const startCenter = { cx: 40, cy: -25 };
    let worstDrift = 0;

    for (const rotation of ROTATIONS) {
      for (const flip of FLIPS) {
        for (const handle of HANDLES) {
          const addressesX = handle.includes('w') || handle.includes('e');
          const addressesY = handle.includes('n') || handle.includes('s');

          // Simulate a resize result in LOCAL axes: the dragged edge moves,
          // the anchored edge stays put (what calculateResizedRect produces).
          const grow = 60;
          const next: Rect = {
            x: addressesX && handle.includes('w') ? startLocalRect.x - grow : startLocalRect.x,
            y: addressesY && handle.includes('n') ? startLocalRect.y - grow : startLocalRect.y,
            w: addressesX ? startLocalRect.w + grow : startLocalRect.w,
            h: addressesY ? startLocalRect.h + grow : startLocalRect.h,
          };

          // The anchor is the corner/edge OPPOSITE the handle, in local coords.
          const anchorBefore = {
            x: handle.includes('w') ? startLocalRect.x + startLocalRect.w : startLocalRect.x,
            y: handle.includes('n') ? startLocalRect.y + startLocalRect.h : startLocalRect.y,
          };
          const anchorWorldBefore = renderPointToWorld(
            startCenter, { w: startLocalRect.w, h: startLocalRect.h }, rotation, flip, anchorBefore
          );

          // PRODUCTION helper under test.
          const nextCenter = localToWorldCenter(startCenter, startLocalRect, next, { rotation, flip });

          // After write-back the bounding IS `next`, so local coords re-base to
          // its top-left → the anchor sits at 0 or w/h.
          const anchorAfter = {
            x: handle.includes('w') ? next.w : 0,
            y: handle.includes('n') ? next.h : 0,
          };
          const anchorWorldAfter = renderPointToWorld(
            { cx: nextCenter.x, cy: nextCenter.y }, { w: next.w, h: next.h }, rotation, flip, anchorAfter
          );

          const drift = Math.hypot(
            anchorWorldAfter.x - anchorWorldBefore.x,
            anchorWorldAfter.y - anchorWorldBefore.y
          );
          worstDrift = Math.max(worstDrift, drift);
        }
      }
    }

    // Zero drift = the helper's convention matches the renderer's exactly.
    // A mirrored sign would blow this up by tens of pixels.
    expect(worstDrift).toBeLessThan(1e-9);
  });

  it('is a no-op when the local rect did not move', () => {
    const rect: Rect = { x: 0, y: 0, w: 120, h: 80 };
    for (const rotation of ROTATIONS) {
      const r = localToWorldCenter({ cx: 12, cy: -8 }, rect, rect, { rotation, flip: { h: false, v: false } });
      expect(r.x).toBeCloseTo(12, 10);
      expect(r.y).toBeCloseTo(-8, 10);
    }
  });

  it('at rotation 0 reduces to a plain centre translation', () => {
    const start: Rect = { x: 0, y: 0, w: 100, h: 100 };
    // Grow width by 40 keeping the left edge → local centre moves +20 in x.
    const next: Rect = { x: 0, y: 0, w: 140, h: 100 };
    const r = localToWorldCenter({ cx: 0, cy: 0 }, start, next, { rotation: 0, flip: { h: false, v: false } });
    expect(r.x).toBeCloseTo(20, 10);
    expect(r.y).toBeCloseTo(0, 10);
  });

  it('at 90° the local x growth moves the world centre along +y', () => {
    const start: Rect = { x: 0, y: 0, w: 100, h: 100 };
    const next: Rect = { x: 0, y: 0, w: 140, h: 100 };
    const r = localToWorldCenter({ cx: 0, cy: 0 }, start, next, { rotation: 90, flip: { h: false, v: false } });
    expect(r.x).toBeCloseTo(0, 10);
    expect(r.y).toBeCloseTo(20, 10);
  });

  it('flip.h mirrors the local x contribution (guards the F-before-R order)', () => {
    const start: Rect = { x: 0, y: 0, w: 100, h: 100 };
    const next: Rect = { x: 0, y: 0, w: 140, h: 100 };
    const plain = localToWorldCenter({ cx: 0, cy: 0 }, start, next, { rotation: 0, flip: { h: false, v: false } });
    const mirrored = localToWorldCenter({ cx: 0, cy: 0 }, start, next, { rotation: 0, flip: { h: true, v: false } });
    expect(plain.x).toBeCloseTo(20, 10);
    expect(mirrored.x).toBeCloseTo(-20, 10);
  });

  it('tolerates an omitted flip (defaults to no mirroring)', () => {
    const start: Rect = { x: 0, y: 0, w: 100, h: 100 };
    const next: Rect = { x: 0, y: 0, w: 140, h: 100 };
    const withUndef = localToWorldCenter({ cx: 0, cy: 0 }, start, next, { rotation: 0 });
    expect(withUndef.x).toBeCloseTo(20, 10);
    expect(withUndef.y).toBeCloseTo(0, 10);
  });

  /**
   * Pins the ORDER of the orientation product (O = R × F, not F × R).
   *
   * This needs rotation ≠ 0 AND a mirror simultaneously — with either one alone
   * the two orders coincide, so the other cases above cannot detect a swap.
   * Expected values are derived BY HAND here (not via getOrientationMatrix) so
   * the assertion is independent of the implementation it guards:
   *
   *   R(90) = [[0,-1],[1,0]]   F_h = [[-1,0],[0,1]]
   *   R × F = [[0,-1],[-1,0]]  →  (20,0) ↦ (0,-20)   ← correct
   *   F × R = [[0, 1],[ 1,0]]  →  (20,0) ↦ (0, 20)   ← swapped, opposite sign
   */
  it('pins O = R × F (mirror first, then rotate) — catches an order swap', () => {
    const start: Rect = { x: 0, y: 0, w: 100, h: 100 };
    // Grow width by 40 keeping the left edge → local centre delta = (+20, 0).
    const next: Rect = { x: 0, y: 0, w: 140, h: 100 };

    const r = localToWorldCenter(
      { cx: 0, cy: 0 }, start, next,
      { rotation: 90, flip: { h: true, v: false } }
    );

    expect(r.x).toBeCloseTo(0, 10);
    expect(r.y).toBeCloseTo(-20, 10);
  });

  /** Same guard on the other axis: local y growth under 90° + flip.v. */
  it('pins O = R × F on the y axis too', () => {
    const start: Rect = { x: 0, y: 0, w: 100, h: 100 };
    // Grow height by 40 keeping the top edge → local centre delta = (0, +20).
    const next: Rect = { x: 0, y: 0, w: 100, h: 140 };

    // R(90) × F_v = [[0,-1],[1,0]] × [[1,0],[0,-1]] = [[0,1],[1,0]]
    //   → (0,20) ↦ (20, 0)
    const r = localToWorldCenter(
      { cx: 0, cy: 0 }, start, next,
      { rotation: 90, flip: { h: false, v: true } }
    );

    expect(r.x).toBeCloseTo(20, 10);
    expect(r.y).toBeCloseTo(0, 10);
  });
});

