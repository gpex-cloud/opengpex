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
 * SceneAssembler.contentView.test.ts — P1 §4 content/view assembly split.
 *
 * Locks the invariant BOTH ways (mirrors the 阶段 1b compose/view tests):
 *   (a) `buildContent` is CAMERA-INDEPENDENT — the SAME content (identical
 *       `layers`, frame, artboard) is produced regardless of camera/viewport/dpr;
 *   (b) `composeView` is where — and the ONLY place — the camera lands: two views
 *       folded onto ONE content differ in `view.transform` yet SHARE the exact
 *       same `layers` array reference (that reference stability is what the CPU
 *       content cache + the engine signature memo rely on).
 *
 * If someone re-bakes the camera into `buildContent` (regressing P1 / 缺陷 5),
 * (a) fails; if `composeView` stops sharing the content's `layers`, (b) fails.
 */

import { describe, it, expect, vi } from 'vitest';
import { SceneAssembler } from './SceneAssembler';
import { snapCanvasRect } from '@opengpex/editor/core/geometry/operators/snapping';
import type { Frame, CameraState, Dimensions, GeometryService, Layer } from '@opengpex/editor/core/types';

function createMockGeometry(): GeometryService {
  return {
    Matrix: {
      translate: vi.fn().mockImplementation((x: number, y: number) => ({
        a: 1, b: 0, c: 0, d: 1, tx: x, ty: y,
        multiply: vi.fn().mockImplementation((m: { a: number; d: number }) => ({
          a: m.a, b: 0, c: 0, d: m.d, tx: x, ty: y,
        })),
      })),
      scale: vi.fn().mockImplementation((sx: number, sy: number) => ({ a: sx, b: 0, c: 0, d: sy, tx: 0, ty: 0 })),
    },
    transform: {
      getLayerLocalMatrix: vi.fn().mockReturnValue({ a: 1, b: 0, c: 0, d: 1, tx: 10, ty: 20 }),
    },
  } as unknown as GeometryService;
}

const baseFrame = {
  id: 'frame-1',
  name: 'Artboard',
  canvas: { w: 800, h: 600 },
  camera: { x: 0, y: 0, k: 1 },
  colorSpace: 'srgb',
  trc: 'linear',
  layers: { order: [], byId: {} },
} as unknown as Frame;

function imageLayer(id: string): Layer {
  return {
    id, name: id, type: 'image', src: `${id}.png`, assetId: `asset-${id}`,
    cx: 400, cy: 300, scale: 1, rotation: 0, flip: { h: false, v: false },
    bounding: { w: 100, h: 100 }, visible: true, locked: false, opacity: 1,
  } as unknown as Layer;
}

const viewportDim: Dimensions = { w: 1000, h: 800 };

describe('SceneAssembler content/view split (P1 §4)', () => {
  it('(a) buildContent is CAMERA-INDEPENDENT: same content ignoring camera args', () => {
    const frame: Frame = { ...baseFrame, layers: { order: ['L1'], byId: { L1: imageLayer('L1') } } };

    const a = SceneAssembler.buildContent({ frame, geometry: createMockGeometry() });
    const b = SceneAssembler.buildContent({ frame, geometry: createMockGeometry() });

    // Same document size, same layer set — buildContent takes no camera at all.
    expect(a.content.frame).toEqual({ width: 800, height: 600 });
    expect(a.content.layers.length).toBe(1);
    expect(a.content.layers[0].id).toBe('L1');
    // Layer transform is the bare M_layer (camera not baked).
    expect(a.content.layers[0].transform).toEqual({ a: 1, b: 0, c: 0, d: 1, tx: 10, ty: 20 });
    expect(b.content.frame).toEqual(a.content.frame);
    expect(b.content.layers[0].transform).toEqual(a.content.layers[0].transform);
  });

  it('(b) composeView folds the camera; two cameras SHARE the content layers ref', () => {
    const frame: Frame = { ...baseFrame, layers: { order: ['L1'], byId: { L1: imageLayer('L1') } } };
    const { content } = SceneAssembler.buildContent({ frame, geometry: createMockGeometry() });

    const camA: CameraState = { x: 0, y: 0, k: 1 };
    const camB: CameraState = { x: 40, y: 50, k: 2 };
    const dpr = 2;

    const sceneA = SceneAssembler.composeView(content, {
      frame, camera: camA, viewportDim, dpr, geometry: createMockGeometry(),
    });
    const sceneB = SceneAssembler.composeView(content, {
      frame, camera: camB, viewportDim, dpr, geometry: createMockGeometry(),
    });

    // The camera lands in view.transform — derived from the real snapping op.
    const snapA = snapCanvasRect(camA, frame.canvas, dpr);
    const snapB = snapCanvasRect(camB, frame.canvas, dpr);
    expect(sceneA.view.transform.a).toBeCloseTo(snapA.renderScale.x, 6);
    expect(sceneB.view.transform.a).toBeCloseTo(snapB.renderScale.x, 6);
    // Different cameras → different view transforms...
    expect(sceneB.view.transform.a).not.toBeCloseTo(sceneA.view.transform.a, 6);

    // ...but the composited content (layers) is SHARED by reference. This is the
    // load-bearing invariant for the CPU content cache + engine signature memo.
    expect(sceneA.layers).toBe(content.layers);
    expect(sceneB.layers).toBe(content.layers);
    expect(sceneA.layers).toBe(sceneB.layers);

    // Frame (document) size is camera-independent; view.target is viewport×dpr.
    expect(sceneA.frame).toEqual({ width: 800, height: 600 });
    expect(sceneA.view.target).toEqual({ width: 2000, height: 1600 });
  });

  it('channelMask is a VIEW concern (lives in composeView, not content)', () => {
    const frame: Frame = { ...baseFrame, layers: { order: ['L1'], byId: { L1: imageLayer('L1') } } };
    const { content } = SceneAssembler.buildContent({ frame, geometry: createMockGeometry() });

    const scene = SceneAssembler.composeView(content, {
      frame, camera: { x: 0, y: 0, k: 1 }, viewportDim, dpr: 1,
      geometry: createMockGeometry(), channelMask: 'r',
    });

    expect(scene.display.channelMask).toBe('r');
    expect(scene.display.colorSpace).toBe('srgb');
    // content itself carries no channelMask field (compositing is channel-agnostic).
    expect('channelMask' in content).toBe(false);
  });
});

