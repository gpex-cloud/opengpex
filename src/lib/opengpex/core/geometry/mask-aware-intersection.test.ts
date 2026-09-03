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
 * Regression suite for the mask-aware logical intersection
 * (20260903_mask_aware_intersection_spec.md §8).
 */

import { describe, it, expect } from 'vitest';
import {
  getEffectiveVisibleShape,
  intersectWithLayer,
} from '@opengpex/editor/core/geometry/operators/shape';
import { differencePathWithPath } from '@opengpex/editor/core/geometry/poly-clip';
import { parsePathDataToRings } from '@opengpex/editor/core/geometry/operators/point2d';
import { asLocalShape, type Layer, type LocalShape, type VectorMask, type BitmapMask } from '@opengpex/editor/core/types';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function rectShape(x: number, y: number, w: number, h: number): LocalShape {
  return asLocalShape({ x, y, w, h }, 'rect');
}

function pathRect(x: number, y: number, w: number, h: number): LocalShape {
  return {
    ...asLocalShape({ x, y, w, h }, 'path'),
    pathData: `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`,
  } as LocalShape;
}

function vmask(shape: LocalShape, opts: { inverted: boolean; feather?: number; enabled?: boolean; id?: string }): VectorMask {
  return {
    id: opts.id ?? `mask-${Math.random()}`,
    shape,
    inverted: opts.inverted,
    feather: opts.feather ?? 0,
    enabled: opts.enabled ?? true,
  };
}

function bmask(opts: { enabled?: boolean }): BitmapMask {
  return {
    id: 'bmask-1',
    src: 'data:,',
    assetId: 'asset-1',
    bounds: { x: 0, y: 0, w: 10, h: 10 } as BitmapMask['bounds'],
    inverted: false,
    enabled: opts.enabled ?? true,
    feather: 0,
  };
}

function baseLayer(overrides: Partial<Layer> = {}): Layer {
  return {
    id: 'A',
    name: 'A',
    cx: 0,
    cy: 0,
    rotation: 0,
    scale: 1,
    flip: { h: false, v: false },
    bounding: { w: 100, h: 100 },
    visibleShape: rectShape(0, 0, 100, 100),
    vectorMasks: [],
    bitmapMasks: [],
    ...overrides,
  } as unknown as Layer;
}

function ringCount(shape: LocalShape): number {
  const pd = (shape as { pathData?: string }).pathData ?? '';
  return parsePathDataToRings(pd).length;
}


// ─── Tests ───────────────────────────────────────────────────────────────────

describe('differencePathWithPath', () => {
  it('subtracts B from A, producing a multi-ring polygon when B is interior', () => {
    const A = `M 0 0 L 100 0 L 100 100 L 0 100 Z`;
    const B = `M 40 40 L 60 40 L 60 60 L 40 60 Z`;
    const res = differencePathWithPath(A, B);
    expect(res).not.toBeNull();
    expect(parsePathDataToRings(res!.pathData).length).toBe(2);
  });

  it('returns null when A is fully covered by B', () => {
    const A = `M 10 10 L 20 10 L 20 20 L 10 20 Z`;
    const B = `M 0 0 L 100 0 L 100 100 L 0 100 Z`;
    expect(differencePathWithPath(A, B)).toBeNull();
  });

  it('returns A unchanged (normalized) when B is empty', () => {
    const A = `M 0 0 L 10 0 L 10 10 L 0 10 Z`;
    const res = differencePathWithPath(A, '');
    expect(res).not.toBeNull();
    expect(res!.rect).toMatchObject({ x: 0, y: 0, w: 10, h: 10 });
  });
});

describe('getEffectiveVisibleShape', () => {
  it('§8.3 zero regression: no masks → returns the raw visibleShape', () => {
    const layer = baseLayer();
    const eff = getEffectiveVisibleShape(layer);
    expect(eff.degraded).toBe(false);
    expect(eff.shape).toBe(layer.visibleShape);
  });

  it('folds an inverted (hole) mask by subtracting it from the base', () => {
    const hole = vmask(pathRect(40, 40, 20, 20), { inverted: true });
    const layer = baseLayer({ vectorMasks: [hole] });
    const eff = getEffectiveVisibleShape(layer);
    expect(eff.degraded).toBe(false);
    expect(eff.shape.type).toBe('path');
    expect(ringCount(eff.shape)).toBe(2);
  });

  it('folds a clip (inverted=false) mask by intersecting it with the base', () => {
    const clip = vmask(pathRect(20, 20, 40, 40), { inverted: false });
    const layer = baseLayer({ vectorMasks: [clip] });
    const eff = getEffectiveVisibleShape(layer);
    expect(eff.degraded).toBe(false);
    expect(eff.shape.rect).toMatchObject({ x: 20, y: 20, w: 40, h: 40 });
  });

  it('§8.6 multiple hole masks → multi-void polygon', () => {
    const h1 = vmask(pathRect(10, 10, 20, 20), { inverted: true });
    const h2 = vmask(pathRect(60, 60, 20, 20), { inverted: true });
    const layer = baseLayer({ vectorMasks: [h1, h2] });
    const eff = getEffectiveVisibleShape(layer);
    expect(eff.degraded).toBe(false);
    expect(ringCount(eff.shape)).toBe(3);
  });

  it('§8.4 feather>0 mask → degraded (returns untouched visibleShape)', () => {
    const soft = vmask(pathRect(40, 40, 20, 20), { inverted: true, feather: 5 });
    const layer = baseLayer({ vectorMasks: [soft] });
    const eff = getEffectiveVisibleShape(layer);
    expect(eff.degraded).toBe(true);
    expect(eff.shape).toBe(layer.visibleShape);
  });

  it('§8.5 enabled bitmapMask → degraded', () => {
    const layer = baseLayer({ bitmapMasks: [bmask({ enabled: true })] });
    const eff = getEffectiveVisibleShape(layer);
    expect(eff.degraded).toBe(true);
  });

  it('disabled masks are skipped (no degrade, no fold)', () => {
    const disabledSoft = vmask(pathRect(40, 40, 20, 20), { inverted: true, feather: 5, enabled: false });
    const layer = baseLayer({ vectorMasks: [disabledSoft], bitmapMasks: [bmask({ enabled: false })] });
    const eff = getEffectiveVisibleShape(layer);
    expect(eff.degraded).toBe(false);
    expect(eff.shape).toBe(layer.visibleShape);
  });
});

describe('intersectWithLayer (mask-aware)', () => {
  it('§8.1 cut on a source with a prior hole excludes the holed region', () => {
    const holeB = vmask(pathRect(50, 0, 50, 100), { inverted: true });
    const layerA = baseLayer({ vectorMasks: [holeB] });
    const selection = rectShape(25, 25, 50, 50);
    const res = intersectWithLayer(selection, layerA);
    expect(res).not.toBeNull();
    expect(res!.visibleShape.rect).toMatchObject({ x: 25, y: 25, w: 25, h: 50 });
    expect(res!.visibleShape.type).toBe('path');
  });

  it('§8.3 zero regression: rect selection on plain rect layer', () => {
    const layer = baseLayer();
    const selection = rectShape(10, 10, 30, 30);
    const res = intersectWithLayer(selection, layer);
    expect(res).not.toBeNull();
    expect(res!.visibleShape.rect).toMatchObject({ x: 10, y: 10, w: 30, h: 30 });
  });

  it('§8.4/§8.5 degraded layer → returns null (triggers vectorMask fallback)', () => {
    const soft = vmask(pathRect(40, 40, 20, 20), { inverted: true, feather: 5 });
    const layer = baseLayer({ vectorMasks: [soft] });
    const selection = rectShape(10, 10, 30, 30);
    expect(intersectWithLayer(selection, layer)).toBeNull();
  });

  it('selection fully inside a hole → null (no visible content)', () => {
    const holeB = vmask(pathRect(50, 0, 50, 100), { inverted: true });
    const layerA = baseLayer({ vectorMasks: [holeB] });
    const selection = rectShape(60, 20, 20, 20);
    expect(intersectWithLayer(selection, layerA)).toBeNull();
  });
});
