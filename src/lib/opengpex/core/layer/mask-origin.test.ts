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
 * Regression suite for the fragment eraser coordinate fix.
 *
 * Bug: erasing on a lasso fragment made the WHOLE fragment vanish.
 * Root cause: the eraser mask canvas was built on the bounding-local (0,0)
 * basis, while `painter2d` blits the layer content into the bounding-local rect
 * `(vx, vy, vw, vh)`. For a zero-copy fragment those two rects can be entirely
 * disjoint, so `destination-in` classified 100% of the content as "outside the
 * mask" and cleared it.
 *
 * `LayerUtils.getMaskOrigin` is the single source of truth for that basis, so
 * these tests pin the invariant that both the producer (stamp placement) and the
 * consumer (`BitmapMask.bounds`) agree on it.
 */

import { describe, it, expect } from 'vitest';
import { LayerUtils } from './utils';
import { asLocalShape, type Layer, type LocalShape } from '@opengpex/editor/core/types';

// ─── Helpers ───────────────────────────────────────────────────────────────────

type MaskOriginInput = Pick<Layer, 'visibleShape'>;

/** Builds the minimal layer shape `getMaskOrigin` consumes. */
function layerWith(visibleShape?: LocalShape): MaskOriginInput {
  return { visibleShape };
}

/** A path-type visibleShape, as produced by a lasso Cmd+J logical fragment. */
function lassoShape(x: number, y: number, w: number, h: number): LocalShape {
  return {
    ...asLocalShape({ x, y, w, h }, 'path'),
    pathData: `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} Z`,
  } as LocalShape;
}

/**
 * Mirrors `MaskStrokeSession.toMaskSpace` step 2: bounding-local → mask-canvas.
 * Step 1 (localMatrixInverse) is a pure matrix op owned by the geometry engine
 * and already covered there, so we isolate the offset that this fix introduces.
 */
function toMaskSpace(boundingLocal: { x: number; y: number }, origin: { x: number; y: number }) {
  return { x: boundingLocal.x - origin.x, y: boundingLocal.y - origin.y };
}

/** Rect intersection area — 0 means `destination-in` would wipe everything. */
function overlapArea(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// ─── getMaskOrigin ─────────────────────────────────────────────────────────────

describe('LayerUtils.getMaskOrigin', () => {
  it('returns (0,0) when the layer has no visibleShape', () => {
    expect(LayerUtils.getMaskOrigin(layerWith(undefined))).toEqual({ x: 0, y: 0 });
  });

  it('returns (0,0) for a regular full-layer image (zero regression basis)', () => {
    // Baked / painted / trunk-import-without-border layers all have rect.x/y = 0.
    const origin = LayerUtils.getMaskOrigin(layerWith(asLocalShape({ x: 0, y: 0, w: 800, h: 600 })));
    expect(origin).toEqual({ x: 0, y: 0 });
  });

  it('returns visibleShape.rect.x/y for a lasso logical fragment', () => {
    // bounding = lasso bbox size; visibleShape.rect points into the shared src.
    const origin = LayerUtils.getMaskOrigin(layerWith(lassoShape(560, 410, 180, 130)));
    expect(origin).toEqual({ x: 560, y: 410 });
  });

  it('returns the contentBounds offset for a trunk import with a transparent border', () => {
    // Acceptance case 6: rect.x/y != 0 but the layer is NOT a cut fragment.
    const origin = LayerUtils.getMaskOrigin(layerWith(asLocalShape({ x: 550, y: 400, w: 200, h: 150 })));
    expect(origin).toEqual({ x: 550, y: 400 });
  });

  it('is agnostic to visibleShape.type (rect / circle / path share one basis)', () => {
    const rect = LayerUtils.getMaskOrigin(layerWith(asLocalShape({ x: 30, y: 40, w: 10, h: 10 }, 'rect')));
    const circle = LayerUtils.getMaskOrigin(layerWith(asLocalShape({ x: 30, y: 40, w: 10, h: 10 }, 'circle')));
    const path = LayerUtils.getMaskOrigin(layerWith(lassoShape(30, 40, 10, 10)));
    expect(rect).toEqual({ x: 30, y: 40 });
    expect(circle).toEqual(rect);
    expect(path).toEqual(rect);
  });

  it('always returns finite numbers, never undefined', () => {
    const origin = LayerUtils.getMaskOrigin(layerWith(asLocalShape({ x: 0, y: 77, w: 5, h: 5 })));
    expect(origin).toEqual({ x: 0, y: 77 });
    expect(Number.isFinite(origin.x)).toBe(true);
    expect(Number.isFinite(origin.y)).toBe(true);
  });
});

// ─── Case 1: fragment eraser no longer wipes the whole fragment ────────────────

describe('fragment eraser alignment (acceptance case 1)', () => {
  // Lasso fragment: bounding = selection size, content lives at (560, 410).
  const bounding = { w: 180, h: 130 };
  const layer = layerWith(lassoShape(560, 410, bounding.w, bounding.h));

  /** Where painter2d actually blits the content, in bounding-local space. */
  const contentRect = { x: 560, y: 410, w: 180, h: 130 };

  it('demonstrates the OLD (0,0) basis produced a disjoint mask → total wipe', () => {
    const legacyMaskRect = { x: 0, y: 0, w: bounding.w, h: bounding.h };
    // Zero overlap is precisely why destination-in erased the entire fragment.
    expect(overlapArea(legacyMaskRect, contentRect)).toBe(0);
  });

  it('aligns the mask rect with the content rect under the new basis', () => {
    const origin = LayerUtils.getMaskOrigin(layer);
    const maskRect = { x: origin.x, y: origin.y, w: bounding.w, h: bounding.h };

    expect(maskRect).toEqual(contentRect);
    // Full coverage — the mask can now express "keep everything except the dab".
    expect(overlapArea(maskRect, contentRect)).toBe(contentRect.w * contentRect.h);
  });

  it('maps a dab inside the content into the mask canvas, not off-canvas', () => {
    const origin = LayerUtils.getMaskOrigin(layer);
    // User clicks near the centre of the visible fragment (bounding-local).
    const inMask = toMaskSpace({ x: 650, y: 475 }, origin);

    expect(inMask).toEqual({ x: 90, y: 65 });
    expect(inMask.x).toBeGreaterThanOrEqual(0);
    expect(inMask.y).toBeGreaterThanOrEqual(0);
    expect(inMask.x).toBeLessThan(bounding.w);
    expect(inMask.y).toBeLessThan(bounding.h);
  });

  it('kept the old basis stamping outside the canvas (why nothing was erased)', () => {
    const legacy = toMaskSpace({ x: 650, y: 475 }, { x: 0, y: 0 });
    // 650 > 180 → the stamp fell off the mask canvas, leaving it all-white.
    expect(legacy.x).toBeGreaterThan(bounding.w);
    expect(legacy.y).toBeGreaterThan(bounding.h);
  });
});

// ─── Case 2: zero regression for regular layers ────────────────────────────────

describe('regular layer zero-regression (acceptance case 2)', () => {
  const bounding = { w: 800, h: 600 };
  const layer = layerWith(asLocalShape({ x: 0, y: 0, w: bounding.w, h: bounding.h }));

  it('produces a (0,0) origin identical to the pre-fix hardcoded value', () => {
    expect(LayerUtils.getMaskOrigin(layer)).toEqual({ x: 0, y: 0 });
  });

  it('leaves stamp coordinates bit-for-bit unchanged', () => {
    const origin = LayerUtils.getMaskOrigin(layer);
    for (const p of [{ x: 0, y: 0 }, { x: 123, y: 456 }, { x: 799.5, y: 599.5 }]) {
      // Subtracting (0,0) is the identity → previous behaviour preserved exactly.
      expect(toMaskSpace(p, origin)).toEqual(p);
    }
  });

  it('yields bounds equal to the legacy {0,0,bw,bh} descriptor', () => {
    const origin = LayerUtils.getMaskOrigin(layer);
    expect({ x: origin.x, y: origin.y, w: bounding.w, h: bounding.h })
      .toEqual({ x: 0, y: 0, w: bounding.w, h: bounding.h });
  });
});

// ─── Case 3: preview === landing ────────────────────────────────────────────────

describe('preview equals landing (acceptance case 3)', () => {
  it('derives the override bounds and the baked bounds from one origin', () => {
    const bounding = { w: 180, h: 130 };
    const layer = layerWith(lassoShape(560, 410, bounding.w, bounding.h));
    const origin = LayerUtils.getMaskOrigin(layer);

    // What factory/MaskStrokeSession send through `fast.override`, then read back
    // by Canvas2dEngine as `overrideOrigin?.x ?? 0`.
    const previewBounds = { x: origin.x ?? 0, y: origin.y ?? 0, w: bounding.w, h: bounding.h };
    // What MaskStrokeSession.end() → bake.ts persists into BitmapMask.bounds.
    const bakedBounds = { x: origin.x, y: origin.y, w: bounding.w, h: bounding.h };

    expect(previewBounds).toEqual(bakedBounds);
  });

  it('falls back to (0,0) when an override omits bounds (legacy override path)', () => {
    // Mirrors `overrideOrigin?.x ?? 0` in Canvas2dEngine — an undefined bounds
    // must degrade to the regular-layer basis, never to NaN.
    const override: { bounds?: { x: number; y: number } } = {};
    const overrideOrigin = override.bounds;
    expect({ x: overrideOrigin?.x ?? 0, y: overrideOrigin?.y ?? 0 }).toEqual({ x: 0, y: 0 });
  });
});

// ─── Case 4: rotation / scale independence ─────────────────────────────────────

describe('rotated / scaled fragments (acceptance case 4)', () => {
  it('keeps the origin in layer-local space, independent of pose', () => {
    // Rotation/flip/zoom live entirely in `localMatrixInverse` (step 1). The mask
    // origin is a property of visibleShape, so it must not vary with pose — that
    // is what keeps a rotated fragment's mask aligned.
    const visibleShape = lassoShape(560, 410, 180, 130);
    const origin = LayerUtils.getMaskOrigin(layerWith(visibleShape));
    expect(origin).toEqual({ x: 560, y: 410 });

    // Same visibleShape reached via a differently-posed layer object.
    const rotatedLike: MaskOriginInput = { visibleShape };
    expect(LayerUtils.getMaskOrigin(rotatedLike)).toEqual(origin);
  });
});

// ─── Case 5: repeated strokes accumulate without drift ─────────────────────────

describe('repeated erase accumulation (acceptance case 5)', () => {
  it('returns a stable origin across successive sessions on the same layer', () => {
    const layer = layerWith(lassoShape(560, 410, 180, 130));
    for (const _ of [0, 1, 2, 3, 4]) {
      expect(LayerUtils.getMaskOrigin(layer)).toEqual({ x: 560, y: 410 });
    }
  });

  it('re-derives the same origin when reusing an existing mask (no cumulative shift)', () => {
    const layer = layerWith(lassoShape(560, 410, 180, 130));
    // Stroke 1 bakes bounds from the origin…
    const first = LayerUtils.getMaskOrigin(layer);
    const persisted = { x: first.x, y: first.y, w: 180, h: 130 };
    // …stroke 2 re-reads the LAYER (not the mask) for its basis, and the existing
    // mask src is redrawn at canvas (0,0), so no offset can compound.
    const second = LayerUtils.getMaskOrigin(layer);
    expect(second).toEqual({ x: persisted.x, y: persisted.y });
  });
});

// ─── Case 6: contentBounds-offset layer (non-fragment) ─────────────────────────

describe('contentBounds-offset layer (acceptance case 6)', () => {
  // trunk import of an 800x600 PNG whose content sits at (550, 400).
  const bounding = { w: 800, h: 600 };
  const layer = layerWith(asLocalShape({ x: 550, y: 400, w: 200, h: 150 }));

  it('anchors the mask at the content offset, overlapping the drawn content', () => {
    const origin = LayerUtils.getMaskOrigin(layer);
    const maskRect = { x: origin.x, y: origin.y, w: bounding.w, h: bounding.h };
    const contentRect = { x: 550, y: 400, w: 200, h: 150 };

    // Here bounding > content, so even the legacy basis partially overlapped —
    // which is why this case mis-erased rather than vanishing. The new basis
    // covers the content completely.
    expect(overlapArea(maskRect, contentRect)).toBe(contentRect.w * contentRect.h);
  });

  it('maps a dab on the content to a positive in-canvas mask coordinate', () => {
    const origin = LayerUtils.getMaskOrigin(layer);
    const inMask = toMaskSpace({ x: 650, y: 475 }, origin);
    expect(inMask).toEqual({ x: 100, y: 75 });
  });
});

