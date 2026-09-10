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
 * layerGeometry.test.ts — WP-5.3 shared quad-geometry resolution.
 *
 * Locks the exact behavior CompositePass and BlendPass previously duplicated.
 */

import { describe, it, expect } from 'vitest';
import { resolveLayerGeometry, effectiveScale } from './layerGeometry';
import { MAT3_IDENTITY, type LayerNode } from '../../scene/Scene';

function baseLayer(extra: Partial<LayerNode>): LayerNode {
  return {
    id: 'l',
    source: { kind: 'raster', assetId: 'a' },
    transform: MAT3_IDENTITY,
    opacity: 1,
    blendMode: 'source-over',
    ...extra,
  } as LayerNode;
}

describe('resolveLayerGeometry (WP-5.3)', () => {
  it('falls back to texture size with full uv when no crop/width/height', () => {
    const g = resolveLayerGeometry(baseLayer({}), 640, 480);
    expect(g.contentWidth).toBe(640);
    expect(g.contentHeight).toBe(480);
    expect(g.localOffset).toEqual([0, 0]);
    expect(g.uvRect).toEqual([0, 0, 1, 1]);
  });

  it('uses explicit width/height (>0) when present and no crop', () => {
    const g = resolveLayerGeometry(baseLayer({ width: 300, height: 200 }), 640, 480);
    expect(g.contentWidth).toBe(300);
    expect(g.contentHeight).toBe(200);
    expect(g.uvRect).toEqual([0, 0, 1, 1]);
  });

  it('crop wins: content=crop size, offset=crop origin, uv=crop/texSize', () => {
    const g = resolveLayerGeometry(
      baseLayer({ width: 999, height: 999, crop: { x: 50, y: 80, w: 200, h: 300 } }),
      400,
      600,
    );
    expect(g.contentWidth).toBe(200);
    expect(g.contentHeight).toBe(300);
    expect(g.localOffset).toEqual([50, 80]);
    expect(g.uvRect).toEqual([50 / 400, 80 / 600, 200 / 400, 300 / 600]);
  });

  it('guards divide-by-zero texture size in uv (clamps denom to 1)', () => {
    const g = resolveLayerGeometry(baseLayer({ crop: { x: 1, y: 2, w: 3, h: 4 } }), 0, 0);
    expect(g.uvRect).toEqual([1, 2, 3, 4]);
  });

  // ── DPR-aware crop→UV mapping (§fix/20260911) ──────────────────────────────
  // A committed Text layer is rasterized at `bounding × dpr`, so its texture is
  // physical (`logical × dprScale`) while `crop` stays in logical (document) px.

  it('DPR≥2 full-block crop covers the WHOLE physical texture (uv=[0,0,1,1])', () => {
    // 100×34 logical text box, dpr=2 → 200×68 physical texture. Before the fix
    // this produced uv=[0,0,0.5,0.5] (only the top-left quarter) → the "text
    // becomes huge / only top-left visible" bug.
    const g = resolveLayerGeometry(
      baseLayer({ crop: { x: 0, y: 0, w: 100, h: 34 } }),
      200,
      68,
      2,
    );
    // Quad size stays in LOGICAL pixels.
    expect(g.contentWidth).toBe(100);
    expect(g.contentHeight).toBe(34);
    expect(g.localOffset).toEqual([0, 0]);
    // UV now covers the full physical texture.
    expect(g.uvRect).toEqual([0, 0, 1, 1]);
  });

  it('DPR≥2 sub-region crop scales the crop into physical UV space', () => {
    // dpr=2: a logical crop (10,20,40,15) into a 200×100 physical texture.
    const g = resolveLayerGeometry(
      baseLayer({ crop: { x: 10, y: 20, w: 40, h: 15 } }),
      200,
      100,
      2,
    );
    expect(g.contentWidth).toBe(40);
    expect(g.contentHeight).toBe(15);
    expect(g.localOffset).toEqual([10, 20]);
    expect(g.uvRect).toEqual([
      (10 * 2) / 200,
      (20 * 2) / 100,
      (40 * 2) / 200,
      (15 * 2) / 100,
    ]);
  });

  it('dprScale=1 (bitmap/fragment) is byte-for-byte identical to omitting it', () => {
    const layer = baseLayer({ crop: { x: 50, y: 80, w: 200, h: 300 } });
    const withDefault = resolveLayerGeometry(layer, 400, 600);
    const withOne = resolveLayerGeometry(layer, 400, 600, 1);
    expect(withOne).toEqual(withDefault);
    expect(withOne.uvRect).toEqual([50 / 400, 80 / 600, 200 / 400, 300 / 600]);
  });

  it('non-positive dprScale is treated as 1 (defensive)', () => {
    const g = resolveLayerGeometry(baseLayer({ crop: { x: 0, y: 0, w: 100, h: 100 } }), 100, 100, 0);
    expect(g.uvRect).toEqual([0, 0, 1, 1]);
  });
});

describe('effectiveScale — sampler decision (缺陷 3 / §3)', () => {
  it('identity transform → scale 1 (boundary: magnify → nearest)', () => {
    expect(effectiveScale(MAT3_IDENTITY)).toBeCloseTo(1, 6);
  });

  it('uniform zoom in → scale > 1 (magnify)', () => {
    expect(effectiveScale({ a: 3, b: 0, c: 0, d: 3, tx: 0, ty: 0 })).toBeCloseTo(3, 6);
  });

  it('uniform zoom out → scale < 1 (minify)', () => {
    expect(effectiveScale({ a: 0.25, b: 0, c: 0, d: 0.25, tx: 0, ty: 0 })).toBeCloseTo(0.25, 6);
  });

  it('takes the MIN axis (anisotropic): 2x wide, 0.5x tall → 0.5 (minify)', () => {
    expect(effectiveScale({ a: 2, b: 0, c: 0, d: 0.5, tx: 0, ty: 0 })).toBeCloseTo(0.5, 6);
  });

  it('rotation-invariant: 90° rotate at 4x → scale 4 (uses column norms)', () => {
    // 90° rotation puts the scale on b/c instead of a/d.
    expect(effectiveScale({ a: 0, b: 4, c: -4, d: 0, tx: 0, ty: 0 })).toBeCloseTo(4, 6);
  });

  it('translation does not affect scale', () => {
    expect(effectiveScale({ a: 1, b: 0, c: 0, d: 1, tx: 500, ty: -300 })).toBeCloseTo(1, 6);
  });
});

