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
 * SceneAssembler.buildScene.test.ts — WP-5.4 pure / side-effect split.
 *
 * `buildScene` must be pure w.r.t. the engine (no upload side-effects, works
 * with NO engine at all) and return the ordered upload plan; `syncAssets` is the
 * only place that touches the engine.
 */

import { describe, it, expect, vi } from 'vitest';
import { SceneAssembler } from './SceneAssembler';
import type { Frame, CameraState, Dimensions, GeometryService, Layer } from '@opengpex/editor/core/types';

function createMockGeometry(): GeometryService {
  return {
    Matrix: {
      translate: () => ({
        multiply: () => ({
          a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0,
          multiply: () => ({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }),
        }),
      }),
      scale: () => ({}),
    },
    transform: {
      getLayerLocalMatrix: vi.fn().mockReturnValue({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }),
    },
  } as unknown as GeometryService;
}

const dummyFrame = {
  id: 'frame-1',
  name: 'Artboard',
  canvas: { w: 800, h: 600 },
  camera: { x: 0, y: 0, k: 1 },
  colorSpace: 'srgb',
  trc: 'linear',
  layers: { order: [], byId: {} },
} as unknown as Frame;
const cam: CameraState = { x: 0, y: 0, k: 1 };
const viewportDim: Dimensions = { w: 800, h: 600 };

function imageLayer(id: string): Layer {
  return {
    id,
    name: id,
    type: 'image',
    src: `${id}.png`,
    assetId: `asset-${id}`,
    cx: 400,
    cy: 300,
    scale: 1,
    rotation: 0,
    flip: { h: false, v: false },
    bounding: { w: 100, h: 100 },
    visible: true,
    locked: false,
    opacity: 1,
  } as unknown as Layer;
}

describe('SceneAssembler.buildScene / syncAssets split (WP-5.4)', () => {
  it('buildScene is pure: produces a Scene with NO engine and no side-effects', () => {
    const frame: Frame = {
      ...dummyFrame,
      layers: { order: ['l1'], byId: { l1: imageLayer('l1') } },
    };

    // No engine passed at all — must not throw and must still build the scene.
    const { scene, uploads } = SceneAssembler.buildScene({
      frame,
      camera: cam,
      viewportDim,
      dpr: 1,
      geometry: createMockGeometry(),
    });

    expect(scene.layers.length).toBe(1);
    expect(scene.layers[0].id).toBe('l1');
    // No decoded bitmap available in the node test env → no upload captured,
    // but the array is always returned (never engine-coupled).
    expect(Array.isArray(uploads)).toBe(true);
  });

  it('syncAssets flushes the recorded uploads into the engine in order', () => {
    const engine = { has: vi.fn().mockReturnValue(false), upload: vi.fn(), release: vi.fn() };
    const bmpA = { width: 10, height: 10, close() {} } as unknown as ImageBitmap;
    const bmpB = { width: 20, height: 20, close() {} } as unknown as ImageBitmap;

    SceneAssembler.syncAssets(
      [
        { assetId: 'a', bitmap: bmpA },
        { assetId: 'b', bitmap: bmpB },
      ],
      engine as unknown as import('../WebGpuEngine').IEngine,
    );

    expect(engine.upload).toHaveBeenCalledTimes(2);
    expect(engine.upload).toHaveBeenNthCalledWith(1, 'a', bmpA);
    expect(engine.upload).toHaveBeenNthCalledWith(2, 'b', bmpB);
  });

  it('assemble() orchestrates build + sync (backward compatible)', () => {
    const engine = { has: vi.fn().mockReturnValue(false), upload: vi.fn(), release: vi.fn() };
    const frame: Frame = {
      ...dummyFrame,
      layers: { order: ['l1'], byId: { l1: imageLayer('l1') } },
    };

    const scene = SceneAssembler.assemble({
      frame,
      camera: cam,
      viewportDim,
      dpr: 1,
      geometry: createMockGeometry(),
      engine: engine as unknown as import('../WebGpuEngine').IEngine,
    });

    expect(scene.layers.length).toBe(1);
    // No bitmap decoded in node env → nothing to upload, but the orchestration
    // path must run without throwing and must not double-build.
    expect(engine.upload).toHaveBeenCalledTimes(0);
  });
});
