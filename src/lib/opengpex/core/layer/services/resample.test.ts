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
 * Regression suite for the resize (resample) fragment-geometry fix
 * (20260904_resize_fragment_geometry_fix_spec.md §9).
 *
 * These cover the pure geometry / snap / feather / blur math of the uniform
 * branch of `resampleLayer`, using a real GeometryService and a mocked
 * PixelService that records how `resample` was invoked. The Canvas per-pixel
 * parts (visual verification of cases 1/2/6/9) are covered by manual smoke.
 */

import { describe, it, expect, vi } from 'vitest';
import { createResampleOperations } from '@opengpex/editor/core/layer/services/resample';
import { createGeometryService } from '@opengpex/editor/core/geometry';
import { scalePathData, translatePathData } from '@opengpex/editor/core/geometry/operators/shape';
import { parsePathDataToRings } from '@opengpex/editor/core/geometry/operators/point2d';
import {
  asLocalShape,
  type Frame,
  type Layer,
  type LocalShape,
  type VectorMask,
  type BitmapMask,
  type PixelService,
} from '@opengpex/editor/core/types';

// ─── Harness ─────────────────────────────────────────────────────────────────

const geometry = createGeometryService();

interface ResampleCall {
  src: string;
  options: { targetSize?: { w: number; h: number }; maxSize?: number; scale?: number };
}

/**
 * makePixels — mocked PixelService recording every `image.resample` call and
 * `render.compositeResizedLayers` call. resample() returns a fake result whose
 * toAsset() reports a fresh content-addressed asset id derived from src+size.
 */
function makePixels() {
  const resampleCalls: ResampleCall[] = [];
  const compositeCalls: Array<{ layers: Layer[]; outputSize: { w: number; h: number } }> = [];

  const image = {
    resample: vi.fn(async (src: string, options: ResampleCall['options']) => {
      resampleCalls.push({ src, options });
      const size = options.targetSize ?? { w: 999, h: 888 };
      return {
        async toAsset() {
          return {
            assetId: `asset-${src}-${JSON.stringify(options)}`,
            url: `blob:${src}-resampled`,
            dimensions: size,
          };
        },
      };
    }),
  };

  const render = {
    compositeResizedLayers: vi.fn(async (layers: Layer[], _frame: Frame, outputSize: { w: number; h: number }) => {
      compositeCalls.push({ layers, outputSize });
      return {
        result: {
          async toAsset() {
            return { assetId: 'asset-flattened', url: 'blob:flattened', dimensions: outputSize };
          },
        },
      };
    }),
  };

  const pixels = { image, render } as unknown as PixelService;
  return { pixels, resampleCalls, compositeCalls };
}

function pathRect(x: number, y: number, w: number, h: number): string {
  return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
}

function pathShape(x: number, y: number, w: number, h: number): LocalShape {
  return { ...asLocalShape({ x, y, w, h }, 'path'), pathData: pathRect(x, y, w, h) } as LocalShape;
}

function baseFrame(): Frame {
  return {
    id: 'F1',
    name: 'F1',
    canvas: { w: 800, h: 600 },
    dpi: 72,
    camera: { x: 0, y: 0, k: 1 },
    layers: { byId: {}, order: [] },
  } as unknown as Frame;
}

function makeLayer(overrides: Partial<Layer> = {}): Layer {
  return {
    id: 'L1',
    name: 'L1',
    type: 'image',
    src: 'src-A',
    assetId: 'asset-A',
    cx: 0,
    cy: 0,
    scale: 1,
    rotation: 0,
    flip: { h: false, v: false },
    bounding: { w: 100, h: 100 },
    visibleShape: asLocalShape({ x: 0, y: 0, w: 100, h: 100 }, 'rect'),
    vectorMasks: [],
    bitmapMasks: [],
    visible: true,
    locked: false,
    opacity: 1,
    ...overrides,
  } as unknown as Layer;
}

function bboxOfPath(pd: string) {
  const rings = parsePathDataToRings(pd);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
  }
  return { minX, minY, maxX, maxY };
}

// ─── scalePathData primitive ─────────────────────────────────────────────────

describe('scalePathData (geometry.shape)', () => {
  it('scales all vertices with no translation and equals translatePathData(0,0)', () => {
    const pd = pathRect(580, 430, 100, 80);
    const scaled = scalePathData(pd, 2, 2);
    expect(scaled).toBe(translatePathData(pd, 0, 0, 2, 2));
    expect(bboxOfPath(scaled)).toEqual({ minX: 1160, minY: 860, maxX: 1360, maxY: 1020 });
  });

  it('supports anisotropic scale (sx != sy) at the primitive level', () => {
    expect(bboxOfPath(scalePathData(pathRect(10, 20, 30, 40), 2, 3)))
      .toEqual({ minX: 20, minY: 60, maxX: 80, maxY: 180 });
  });

  it('is exposed through the GeometryService.shape namespace', () => {
    expect(geometry.shape.scalePathData(pathRect(0, 0, 10, 10), 2, 2))
      .toBe(scalePathData(pathRect(0, 0, 10, 10), 2, 2));
  });
});

// ─── resampleLayer uniform branch ────────────────────────────────────────────

describe('resampleLayer — uniform branch (resize fragment geometry fix)', () => {
  // Case 1 (A/B): rect cut fragment — shared full 800x600 src, bounding = selection window.
  it('case 1: rect cut fragment scales via {scale}, offset rect scaled+snapped, not lost', async () => {
    const { pixels, resampleCalls, compositeCalls } = makePixels();
    const ops = createResampleOperations(geometry, pixels);

    const layer = makeLayer({
      src: 'shared-full-src',
      assetId: 'asset-shared',
      bounding: { w: 100, h: 80 },
      visibleShape: asLocalShape({ x: 580, y: 430, w: 100, h: 80 }, 'rect'),
    });

    const res = await ops.resampleLayer(baseFrame(), layer, 2, 2);
    expect(res).not.toBeNull();

    // Route X: resample called with { scale }, NOT { targetSize: bounding*scale }.
    // Anti-regression guard: the old code squashed the shared src into bounding*scale.
    expect(compositeCalls.length).toBe(0);
    expect(resampleCalls.length).toBe(1);
    expect(resampleCalls[0].src).toBe('shared-full-src');
    expect(resampleCalls[0].options).toEqual({ scale: 2 });
    expect(resampleCalls[0].options.targetSize).toBeUndefined();

    // visibleShape offset scaled: (580,430,100,80) → (1160,860,200,160), valid against
    // the new (trueSrc*2) src — no out-of-bounds read.
    expect(res!.patch.visibleShape!.rect).toEqual({ x: 1160, y: 860, w: 200, h: 160 });
    expect(res!.patch.bounding).toEqual({ w: 200, h: 160 });
  });

  // Case 2 (C): lasso cut fragment — path-type visibleShape, pathData must scale.
  it('case 2: lasso fragment scales visibleShape.pathData (outline not misplaced)', async () => {
    const { pixels } = makePixels();
    const ops = createResampleOperations(geometry, pixels);
    const layer = makeLayer({
      src: 'shared-full-src',
      bounding: { w: 100, h: 80 },
      visibleShape: pathShape(580, 430, 100, 80),
    });

    const res = await ops.resampleLayer(baseFrame(), layer, 2, 2);
    const vs = res!.patch.visibleShape as LocalShape & { pathData: string };
    expect(bboxOfPath(vs.pathData)).toEqual({ minX: 1160, minY: 860, maxX: 1360, maxY: 1020 });
    expect(vs.rect).toEqual({ x: 1160, y: 860, w: 200, h: 160 });
  });

  // Case 3: normal full-image layer (src == bounding). Zero regression.
  it('case 3: full-image layer (src==bounding) resizes with matching geometry', async () => {
    const { pixels, resampleCalls } = makePixels();
    const ops = createResampleOperations(geometry, pixels);
    const layer = makeLayer({
      bounding: { w: 800, h: 600 },
      visibleShape: asLocalShape({ x: 0, y: 0, w: 800, h: 600 }, 'rect'),
    });

    const res = await ops.resampleLayer(baseFrame(), layer, 0.5, 0.5);
    expect(resampleCalls[0].options).toEqual({ scale: 0.5 });
    expect(res!.patch.bounding).toEqual({ w: 400, h: 300 });
    expect(res!.patch.visibleShape!.rect).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });

  // Case 5 (E): Apply-Mask path vmask — vectorMask.shape.pathData must scale.
  it('case 5: path vectorMask scales rect + pathData + preserves other fields', async () => {
    const { pixels } = makePixels();
    const ops = createResampleOperations(geometry, pixels);
    const vmask: VectorMask = {
      id: 'vm-1',
      shape: pathShape(10, 10, 40, 40),
      inverted: true,
      feather: 0,
      enabled: true,
      assocLayerId: 'frag-9',
    };
    const res = await ops.resampleLayer(baseFrame(), makeLayer({ vectorMasks: [vmask] }), 2, 2);
    const m = res!.patch.vectorMasks![0] as VectorMask & { shape: { pathData: string } };
    expect(bboxOfPath(m.shape.pathData)).toEqual({ minX: 20, minY: 20, maxX: 100, maxY: 100 });
    expect(m.shape.rect).toEqual({ x: 20, y: 20, w: 80, h: 80 });
    expect(m.inverted).toBe(true);
    expect(m.enabled).toBe(true);
    expect(m.assocLayerId).toBe('frag-9');
    expect(m.id).toBe('vm-1');
  });

  // Case 6 (D): eraser bitmapMask — bounds scaled + grayscale src re-resampled to new bounds.
  it('case 6: bitmapMask scales bounds and resamples grayscale src to new bounds', async () => {
    const { pixels, resampleCalls } = makePixels();
    const ops = createResampleOperations(geometry, pixels);
    const bm: BitmapMask = {
      id: 'bm-1',
      src: 'mask-gray-src',
      assetId: 'asset-gray',
      bounds: { x: 10, y: 20, w: 50, h: 40 } as BitmapMask['bounds'],
      inverted: false,
      enabled: true,
      feather: 4,
      tag: 'drilled',
    };
    const res = await ops.resampleLayer(baseFrame(), makeLayer({ bitmapMasks: [bm] }), 2, 2);
    const patched = res!.patch.bitmapMasks![0];
    expect(patched.bounds).toEqual({ x: 20, y: 40, w: 100, h: 80 });
    expect(patched.feather).toBe(8);
    expect(patched.tag).toBe('drilled');
    expect(patched.inverted).toBe(false);
    const bmCall = resampleCalls.find(c => c.src === 'mask-gray-src');
    expect(bmCall).toBeTruthy();
    expect(bmCall!.options).toEqual({ targetSize: { w: 100, h: 80 } });
    expect(patched.src).toBe('blob:mask-gray-src-resampled');
  });

  // Case 7 (F): feather scales with the uniform factor.
  it('case 7: vectorMask.feather scales by the uniform factor', async () => {
    const { pixels } = makePixels();
    const ops = createResampleOperations(geometry, pixels);
    const vmask: VectorMask = {
      id: 'vm-f', shape: asLocalShape({ x: 0, y: 0, w: 20, h: 20 }, 'rect'),
      inverted: false, feather: 6, enabled: true,
    };
    const res = await ops.resampleLayer(baseFrame(), makeLayer({ vectorMasks: [vmask] }), 1.5, 1.5);
    expect(res!.patch.vectorMasks![0].feather).toBeCloseTo(9, 6);
  });

  // Case 8 (G): adjustments.blur scales; untouched when 0.
  it('case 8: adjustments.blur scales when > 0', async () => {
    const { pixels } = makePixels();
    const ops = createResampleOperations(geometry, pixels);
    const adjustments = { brightness: 100, contrast: 100, saturation: 100, hueRotate: 0, blur: 5 };
    const res = await ops.resampleLayer(baseFrame(), makeLayer({ adjustments }), 2, 2);
    expect(res!.patch.adjustments!.blur).toBe(10);
  });

  it('case 8b: adjustments.blur=0 produces no adjustments patch', async () => {
    const { pixels } = makePixels();
    const ops = createResampleOperations(geometry, pixels);
    const adjustments = { brightness: 100, contrast: 100, saturation: 100, hueRotate: 0, blur: 0 };
    const res = await ops.resampleLayer(baseFrame(), makeLayer({ adjustments }), 2, 2);
    expect(res!.patch.adjustments).toBeUndefined();
  });
  // Text layer: renders live from textData via fillText → fontSize / box must scale,
  // lineHeight (unitless multiplier) must NOT scale.
  it('text: scales textData.fontSize + fixed box dims, leaves lineHeight/style untouched', async () => {
    const { pixels } = makePixels();
    const ops = createResampleOperations(geometry, pixels);
    const textLayer = makeLayer({
      type: 'text',
      src: 'data:image/gif;base64,transparent',
      assetId: 'asset-transparent-pixel',
      bounding: { w: 200, h: 60 },
      textData: {
        content: 'Hi',
        fontFamily: 'Inter',
        fontSize: 24,
        fontWeight: 400,
        color: '#FFFFFF',
        align: 'left',
        lineHeight: 1.4,
        boxMode: 'fixed',
        boxWidth: 200,
        boxHeight: 60,
      },
    });

    const res = await ops.resampleLayer(baseFrame(), textLayer, 2, 2);
    const td = res!.patch.textData!;
    expect(td.fontSize).toBe(48);
    expect(td.boxWidth).toBe(400);
    expect(td.boxHeight).toBe(120);
    // Unitless multiplier + style fields unchanged.
    expect(td.lineHeight).toBe(1.4);
    expect(td.fontFamily).toBe('Inter');
    expect(td.fontWeight).toBe(400);
    expect(td.align).toBe('left');
    expect(td.content).toBe('Hi');
    // bounding scaled too so the box + glyphs stay consistent.
    expect(res!.patch.bounding).toEqual({ w: 400, h: 120 });
  });

  it('text: auto box (no boxWidth/boxHeight) scales fontSize only, no box fields added', async () => {
    const { pixels } = makePixels();
    const ops = createResampleOperations(geometry, pixels);
    const textLayer = makeLayer({
      type: 'text',
      src: 'data:image/gif;base64,transparent',
      assetId: 'asset-transparent-pixel',
      bounding: { w: 120, h: 40 },
      textData: {
        content: 'Hi', fontFamily: 'Inter', fontSize: 20, fontWeight: 400,
        color: '#000', align: 'left', lineHeight: 1.2, boxMode: 'auto',
      },
    });

    const res = await ops.resampleLayer(baseFrame(), textLayer, 1.5, 1.5);
    const td = res!.patch.textData!;
    expect(td.fontSize).toBe(30);
    expect(td.boxWidth).toBeUndefined();
    expect(td.boxHeight).toBeUndefined();
  });




  // Case 9 (H): sub-pixel — non-integer scale snaps rect to grid, pathData stays exact.
  it('case 9: non-integer scale snaps rect to grid but leaves pathData sub-pixel exact', async () => {
    const { pixels } = makePixels();
    const ops = createResampleOperations(geometry, pixels);
    const layer = makeLayer({
      src: 'shared-full-src',
      bounding: { w: 100, h: 80 },
      visibleShape: pathShape(580, 430, 100, 80),
    });

    const res = await ops.resampleLayer(baseFrame(), layer, 1.37, 1.37);
    const vs = res!.patch.visibleShape as LocalShape & { pathData: string };
    // 580*1.37=794.6→795, 430*1.37=589.1→589, 100*1.37=137, 80*1.37=109.6→110
    expect(vs.rect).toEqual({ x: 795, y: 589, w: 137, h: 110 });
    // pathData NOT snapped — bbox keeps the exact float positions.
    const bb = bboxOfPath(vs.pathData);
    expect(bb.minX).toBeCloseTo(794.6, 6);
    expect(bb.minY).toBeCloseTo(589.1, 6);
  });

  it('cx/cy use half-pixel snapping', async () => {
    const { pixels } = makePixels();
    const ops = createResampleOperations(geometry, pixels);
    const res = await ops.resampleLayer(baseFrame(), makeLayer({ cx: 100, cy: 33 }), 1.37, 1.37);
    expect((res!.patch.cx! * 2) % 1).toBe(0);
    expect((res!.patch.cy! * 2) % 1).toBe(0);
  });
});

// ─── Non-uniform branch (case 10) + fallback ─────────────────────────────────

describe('resampleLayer — non-uniform branch & fallback', () => {
  it('case 10: non-uniform scale flattens via compositeResizedLayers and clears vectorMasks', async () => {
    const { pixels, resampleCalls, compositeCalls } = makePixels();
    const ops = createResampleOperations(geometry, pixels);
    const layer = makeLayer({
      bounding: { w: 100, h: 80 },
      visibleShape: pathShape(10, 10, 80, 60),
      vectorMasks: [{ id: 'vm', shape: pathShape(0, 0, 10, 10), inverted: false, feather: 0, enabled: true }],
    });

    const res = await ops.resampleLayer(baseFrame(), layer, 2, 3);
    expect(resampleCalls.length).toBe(0);
    expect(compositeCalls.length).toBe(1);
    expect(res!.patch.vectorMasks).toEqual([]);
    expect(res!.patch.visibleShape!.type).toBe('rect');
    expect(res!.patch.rotation).toBe(0);
  });

  it('falls back to flatten when uniform resample throws (never the buggy bounding×scale path)', async () => {
    const { pixels, compositeCalls } = makePixels();
    (pixels.image.resample as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('decode failed');
    });
    const ops = createResampleOperations(geometry, pixels);
    const layer = makeLayer({ src: 'shared-full-src', bounding: { w: 100, h: 80 } });

    const res = await ops.resampleLayer(baseFrame(), layer, 2, 2);
    expect(res).not.toBeNull();
    expect(compositeCalls.length).toBe(1);
    expect(res!.patch.vectorMasks).toEqual([]);
  });
});

