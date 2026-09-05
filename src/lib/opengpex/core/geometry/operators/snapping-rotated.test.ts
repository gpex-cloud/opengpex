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
 * Rotation-aware edge snapping (`snapEdgeRotated`) — behaviour suite.
 *
 * Guards the AABB-projection snapping semantics used by `TransformHandler`'s
 * orientation branch for rotated / mirrored marker + text layers (待办 B).
 *
 * THE CONTRACT under test:
 *   1. The world **AABB** of the projected local rect is what snaps — never the
 *      slanted true edges (which have no solution against an axis-aligned line
 *      at e.g. 45°).
 *   2. Which AABB side is "active" follows the handle's LOCAL outward direction
 *      pushed through the orientation matrix — so a local 'e' handle on a
 *      180°-rotated layer snaps the AABB's LEFT edge.
 *   3. Guides are always plain H/V world-space lines (`{ x?, y? }`), so the
 *      existing SmartGuides renderer needs no changes.
 *   4. Out-of-threshold input is returned untouched with `smartguides: null`,
 *      so callers can apply the result unconditionally.
 */

import { describe, it, expect } from 'vitest';
import { snapEdgeRotated, snapEdge } from './snapping';
import { Frame, Rect } from '@opengpex/editor/core/types';

const CANVAS = { w: 400, h: 300 };

/** Minimal frame: canvas dims + camera (threshold divisor) + no layer targets. */
function makeFrame(layers: Record<string, unknown> = {}, order: string[] = []): Frame {
  return {
    canvas: { ...CANVAS },
    camera: { x: 0, y: 0, k: 1 },
    layers: { byId: layers, order },
  } as unknown as Frame;
}

/** Project a local-rect corner into canvas-local space, mirroring snapEdgeRotated. */
function projectCorners(
  localRect: Rect,
  startLocalRect: Rect,
  startCenter: { cx: number; cy: number },
  rotationDeg: number,
  flip: { h: boolean; v: boolean } = { h: false, v: false }
) {
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const mx = flip.h ? -1 : 1;
  const my = flip.v ? -1 : 1;
  const scx = startLocalRect.x + startLocalRect.w / 2;
  const scy = startLocalRect.y + startLocalRect.h / 2;

  const map = (lx: number, ly: number) => {
    const ox = (lx - scx) * mx;
    const oy = (ly - scy) * my;
    return {
      x: startCenter.cx + (cos * ox - sin * oy) + CANVAS.w / 2,
      y: startCenter.cy + (sin * ox + cos * oy) + CANVAS.h / 2,
    };
  };

  return [
    map(localRect.x, localRect.y),
    map(localRect.x + localRect.w, localRect.y),
    map(localRect.x, localRect.y + localRect.h),
    map(localRect.x + localRect.w, localRect.y + localRect.h),
  ];
}

/** World AABB (canvas-local) of a local rect under a given pose. */
function aabbOf(
  localRect: Rect,
  startLocalRect: Rect,
  startCenter: { cx: number; cy: number },
  rotationDeg: number,
  flip?: { h: boolean; v: boolean }
) {
  const c = projectCorners(localRect, startLocalRect, startCenter, rotationDeg, flip);
  const xs = c.map(p => p.x);
  const ys = c.map(p => p.y);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

describe('snapEdgeRotated — active AABB edge selection', () => {
  // Layer centred at world (0,0) → canvas centre (200,150). 100×80 bounding.
  const startLocalRect: Rect = { x: 0, y: 0, w: 100, h: 80 };
  const startCenter = { cx: 0, cy: 0 };

  it('90° rotation: local "e" handle pushes the AABB BOTTOM edge', () => {
    // At +90°, local +x maps to canvas +y, so the local right edge becomes the
    // AABB's bottom. AABB bottom = ch/2 + (w − startW/2) → w=190 gives 290,
    // i.e. 10px from the canvas bottom (300).
    const localRect: Rect = { x: 0, y: 0, w: 190, h: 80 };
    const before = aabbOf(localRect, startLocalRect, startCenter, 90);
    expect(before.bottom).toBeCloseTo(290, 5);

    const res = snapEdgeRotated(localRect, 'e', {
      rotation: 90,
      flip: { h: false, v: false },
      startCenter,
      startLocalRect,
    }, makeFrame());

    // Snapped to the canvas bottom (ch=300) → world y guide = 300 − 150 = 150.
    expect(res.smartguides).toEqual({ y: 150 });
    // The correction lands on the local WIDTH (the 'e' handle's axis); the
    // anchored local left edge and the unrelated height are untouched.
    expect(res.rect.w).toBeCloseTo(200, 5);
    expect(res.rect.h).toBe(80);
    expect(res.rect.x).toBe(0);

    // The AABB's active edge now sits exactly on the target.
    const after = aabbOf(res.rect, startLocalRect, startCenter, 90);
    expect(after.bottom).toBeCloseTo(300, 5);
  });

  it('180° rotation: local "e" handle pushes the AABB LEFT edge', () => {
    // At 180°, local +x maps to canvas −x → the local right edge becomes the
    // AABB's left. AABB left = cw/2 − (w − startW/2) → w=240 gives 10,
    // i.e. 10px from the canvas left edge (0).
    const localRect: Rect = { x: 0, y: 0, w: 240, h: 80 };
    const before = aabbOf(localRect, startLocalRect, startCenter, 180);
    expect(before.left).toBeCloseTo(10, 5);

    const res = snapEdgeRotated(localRect, 'e', {
      rotation: 180,
      flip: { h: false, v: false },
      startCenter,
      startLocalRect,
    }, makeFrame());

    // Snapped to canvas left (0) → world x guide = 0 − 200 = −200.
    expect(res.smartguides).toEqual({ x: -200 });
    expect(res.rect.w).toBeCloseTo(250, 5);

    const after = aabbOf(res.rect, startLocalRect, startCenter, 180);
    expect(after.left).toBeCloseTo(0, 5);
  });

  it('zero-projection axis is ignored (90°: local "e" has no canvas-x component)', () => {
    // At exactly 90° the local x direction has zero canvas-x projection
    // (cos(90°) ≈ 6e-17 → below DIR_EPSILON), so no vertical guide may appear.
    const localRect: Rect = { x: 0, y: 0, w: 190, h: 80 };
    const res = snapEdgeRotated(localRect, 'e', {
      rotation: 90,
      flip: { h: false, v: false },
      startCenter,
      startLocalRect,
    }, makeFrame());

    expect(res.smartguides?.x).toBeUndefined();
    expect(typeof res.smartguides?.y).toBe('number');
  });
});

describe('snapEdgeRotated — 45° (the case with no axis-aligned solution)', () => {
  const startLocalRect: Rect = { x: 0, y: 0, w: 100, h: 100 };
  const startCenter = { cx: 0, cy: 0 };

  it('still snaps, via the AABB, and emits a plain H/V guide', () => {
    // 100×100 square at 45°, widened via the local 'e' handle. At 45° the local
    // +x axis projects onto BOTH canvas axes at 1/√2, so growing w by δ moves
    // the AABB right edge by δ/√2 — the AABB right must land exactly on a target
    // even though the true (slanted) edge never coincides with a vertical line.
    const localRect: Rect = { x: 0, y: 0, w: 270, h: 100 };
    const before = aabbOf(localRect, startLocalRect, startCenter, 45);
    // AABB right ≈ 129.29 + 270/√2 ≈ 320.24 — within 15px of nothing yet…
    expect(before.right).toBeGreaterThan(300);

    const res = snapEdgeRotated(localRect, 'e', {
      rotation: 45,
      flip: { h: false, v: false },
      startCenter,
      startLocalRect,
    }, makeFrame(), { threshold: 40 });

    // A well-defined result exists (precisely what plain snapEdge cannot do).
    expect(res.smartguides).not.toBeNull();
    // Guides remain plain H/V world-space numbers — no slanted-line payload.
    const keys = Object.keys(res.smartguides!);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every(k => k === 'x' || k === 'y')).toBe(true);
    for (const k of keys) {
      expect(typeof (res.smartguides as Record<string, unknown>)[k]).toBe('number');
    }

    // Only the dragged local axis (width) changed; the anchor side stayed put.
    expect(res.rect.x).toBe(localRect.x);
    expect(res.rect.y).toBe(localRect.y);
    expect(res.rect.h).toBe(localRect.h);
    expect(res.rect.w).not.toBe(localRect.w);

    // And the active AABB edge landed exactly on a canvas target line.
    const after = aabbOf(res.rect, startLocalRect, startCenter, 45);
    const targetsX = [0, 200, 400];
    const targetsY = [0, 150, 300];
    const hit =
      targetsX.some(t => Math.abs(after.right - t) < 1e-6) ||
      targetsY.some(t => Math.abs(after.bottom - t) < 1e-6);
    expect(hit).toBe(true);
  });
});

describe('snapEdgeRotated — no-op guarantees', () => {
  const startLocalRect: Rect = { x: 0, y: 0, w: 100, h: 80 };
  const startCenter = { cx: 0, cy: 0 };

  it('returns the input rect untouched when nothing is within threshold', () => {
    // Small 100×80 at 30°, offset so its AABB stays clear of every target line.
    const localRect: Rect = { x: 0, y: 0, w: 100, h: 80 };
    const res = snapEdgeRotated(localRect, 'se', {
      rotation: 30,
      flip: { h: false, v: false },
      startCenter: { cx: -60, cy: -55 },
      startLocalRect,
    }, makeFrame(), { threshold: 3 });

    expect(res.smartguides).toBeNull();
    expect(res.rect).toEqual(localRect);
  });

  it('honours snapToCanvas:false + snapToLayers:false (no targets at all)', () => {
    const localRect: Rect = { x: 0, y: 0, w: 296, h: 80 };
    const res = snapEdgeRotated(localRect, 'e', {
      rotation: 90,
      flip: { h: false, v: false },
      startCenter,
      startLocalRect,
    }, makeFrame(), { snapToCanvas: false, snapToLayers: false });

    expect(res.smartguides).toBeNull();
    expect(res.rect).toEqual(localRect);
  });

  it('threshold scales with camera zoom (screen-constant hot zone)', () => {
    // At 90° the AABB bottom = ch/2 + (w − startW/2) → w = 190 gives 290,
    // i.e. 10px from the canvas bottom (300).
    const localRect: Rect = { x: 0, y: 0, w: 190, h: 80 };
    const pose = {
      rotation: 90,
      flip: { h: false, v: false },
      startCenter,
      startLocalRect,
    };
    expect(aabbOf(localRect, startLocalRect, startCenter, 90).bottom).toBeCloseTo(290, 5);

    // k=1 → threshold 15 covers the 10px gap; k=4 → 15/4 = 3.75 → miss.
    const zoomedIn = {
      canvas: { ...CANVAS },
      camera: { x: 0, y: 0, k: 4 },
      layers: { byId: {}, order: [] },
    } as unknown as Frame;

    expect(snapEdgeRotated(localRect, 'e', pose, makeFrame()).smartguides).not.toBeNull();
    expect(snapEdgeRotated(localRect, 'e', pose, zoomedIn).smartguides).toBeNull();
  });
});

describe('snapEdge (canvas axes) — unchanged after the shared-helper refactor', () => {
  it('snaps the dragged right edge to the canvas right edge', () => {
    const res = snapEdge({ x: 100, y: 50, w: 298, h: 100 }, 'e', makeFrame());
    expect(res.rect).toEqual({ x: 100, y: 50, w: 300, h: 100 });
    expect(res.smartguides).toEqual({ x: 200 }); // 400 − cw/2
  });

  it('snaps the dragged left edge and keeps the right edge fixed', () => {
    const res = snapEdge({ x: 3, y: 50, w: 200, h: 100 }, 'w', makeFrame());
    // Left snaps to 0; right (203) is preserved.
    expect(res.rect).toEqual({ x: 0, y: 50, w: 203, h: 100 });
    expect(res.smartguides).toEqual({ x: -200 });
  });

  it('snaps both axes independently for a corner handle', () => {
    const res = snapEdge({ x: 100, y: 50, w: 298, h: 248 }, 'se', makeFrame());
    expect(res.rect.w).toBe(300); // right → 400
    expect(res.rect.h).toBe(250); // bottom → 300
    expect(res.smartguides).toEqual({ x: 200, y: 150 });
  });

  it('returns no guides when out of threshold', () => {
    const rect = { x: 100, y: 100, w: 50, h: 40 };
    const res = snapEdge(rect, 'se', makeFrame(), { threshold: 2 });
    expect(res.smartguides).toBeNull();
    expect(res.rect).toEqual(rect);
  });

  it('snaps to the canvas centre lines', () => {
    // Right edge at 198 → 2px from cw/2 = 200.
    const res = snapEdge({ x: 20, y: 50, w: 178, h: 100 }, 'e', makeFrame());
    expect(res.rect.w).toBe(180); // right → 200
    expect(res.smartguides).toEqual({ x: 0 }); // 200 − 200
  });
});

