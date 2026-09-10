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

import { describe, it, expect, vi } from 'vitest';
import { SceneAssembler } from './SceneAssembler';
import { snapCanvasRect } from '@opengpex/editor/core/geometry/operators/snapping';
import type { Frame, CameraState, Dimensions, GeometryService, Layer } from '@opengpex/editor/core/types';

function createMockGeometry(): GeometryService {
  return {
    Matrix: {
      translate: vi.fn().mockImplementation((x: number, y: number) => ({
        a: 1,
        b: 0,
        c: 0,
        d: 1,
        tx: x,
        ty: y,
        multiply: vi.fn().mockImplementation((m: { a: number; b: number; c: number; d: number; tx: number; ty: number }) => ({
          a: m.a,
          b: m.b,
          c: m.c,
          d: m.d,
          tx: x + m.tx,
          ty: y + m.ty,
          multiply: vi.fn().mockImplementation((m2: { a: number; b: number; c: number; d: number; tx: number; ty: number }) => ({
            a: m2.a,
            b: m2.b,
            c: m2.c,
            d: m2.d,
            tx: x + m.tx + m2.tx,
            ty: y + m.ty + m2.ty,
          })),
        })),
      })),
      scale: vi.fn().mockImplementation((sx: number, sy: number) => ({
        a: sx,
        b: 0,
        c: 0,
        d: sy,
        tx: 0,
        ty: 0,
        multiply: vi.fn(),
      })),
    },
    transform: {
      getLayerLocalMatrix: vi.fn().mockReturnValue({
        a: 1,
        b: 0,
        c: 0,
        d: 1,
        tx: 10,
        ty: 20,
      }),
    },
  } as unknown as GeometryService;
}

describe('SceneAssembler', () => {
  const dummyFrame = {
    id: 'frame-1',
    name: 'Artboard 1',
    canvas: { w: 800, h: 600 },
    camera: { x: 0, y: 0, k: 1 },
    colorSpace: 'display-p3',
    trc: 'linear',
    layers: {
      order: [],
      byId: {},
    },
  } as unknown as Frame;

  const dummyCam: CameraState = { x: 0, y: 0, k: 1 };
  const viewportDim: Dimensions = { w: 1000, h: 800 };

  it('assembles an empty frame correctly', () => {
    const geometry = createMockGeometry();
    const scene = SceneAssembler.assemble({
      frame: dummyFrame,
      camera: dummyCam,
      viewportDim,
      dpr: 2,
      geometry,
      channelMask: 'rgb',
    });

    // 缺陷 5 §5 阶段 1b: `frame` is the DOCUMENT (canvas) size, NOT viewport×dpr.
    expect(scene.frame.width).toBe(800); // canvas.w
    expect(scene.frame.height).toBe(600); // canvas.h
    // The swapchain size (viewport × dpr) now lives on `view.target`.
    expect(scene.view.target.width).toBe(2000); // 1000 * 2
    expect(scene.view.target.height).toBe(1600); // 800 * 2
    expect(scene.display.channelMask).toBe('rgb');
    expect(scene.display.colorSpace).toBe('display-p3');
    expect(scene.layers).toEqual([]);
  });

  it('filters invisible layers and group layers', () => {
    const geometry = createMockGeometry();
    const layer1: Layer = {
      id: 'L1',
      name: 'Visible Image',
      type: 'image',
      src: 'test.png',
      assetId: 'asset-1',
      cx: 100,
      cy: 100,
      scale: 1,
      rotation: 0,
      flip: { h: false, v: false },
      bounding: { w: 100, h: 100 },
      visible: true,
      locked: false,
      opacity: 0.9,
    };

    const layer2Hidden: Layer = {
      ...layer1,
      id: 'L2',
      visible: false,
    };

    const groupLayer: Layer = {
      ...layer1,
      id: 'G1',
      type: 'group',
      visible: true,
    };

    const frameWithLayers: Frame = {
      ...dummyFrame,
      layers: {
        order: ['L1', 'L2', 'G1'],
        byId: {
          L1: layer1,
          L2: layer2Hidden,
          G1: groupLayer,
        },
      },
    };

    const scene = SceneAssembler.assemble({
      frame: frameWithLayers,
      camera: dummyCam,
      viewportDim,
      dpr: 1,
      geometry,
    });

    expect(scene.layers.length).toBe(1);
    expect(scene.layers[0].id).toBe('L1');
    expect(scene.layers[0].opacity).toBe(0.9);
    expect(scene.layers[0].blendMode).toBe('source-over');
  });

  it('correctly sets width, height, crop and handles vectorMasks for cut fragments', () => {
    const geometry = createMockGeometry();
    const fragmentLayer: Layer = {
      id: 'frag-1',
      name: 'Fragment',
      type: 'image',
      src: 'original.png',
      assetId: 'asset-1',
      cx: 150,
      cy: 200,
      scale: 1,
      rotation: 0,
      flip: { h: false, v: false },
      bounding: { w: 200, h: 300 },
      visibleShape: {
        type: 'rect',
        rect: { x: 50, y: 80, w: 200, h: 300 },
      } as unknown as Layer['visibleShape'],
      visible: true,
      locked: false,
      opacity: 1.0,
      vectorMasks: [
        {
          id: 'vmask-hole-1',
          shape: {
            type: 'rect',
            rect: { x: 10, y: 10, w: 50, h: 50 },
          } as unknown as import('@opengpex/editor/core/types').LocalShape,
          inverted: true,
          feather: 0,
          enabled: true,
        },
      ],
    };

    const frameWithFrag: Frame = {
      ...dummyFrame,
      layers: {
        order: ['frag-1'],
        byId: {
          'frag-1': fragmentLayer,
        },
      },
    };

    const mockEngine = {
      upload: vi.fn(),
    };

    const scene = SceneAssembler.assemble({
      frame: frameWithFrag,
      camera: dummyCam,
      viewportDim,
      dpr: 1,
      geometry,
      engine: mockEngine as unknown as import('../WebGpuEngine').IEngine,
    });

    expect(scene.layers.length).toBe(1);
    const node = scene.layers[0];
    expect(node.id).toBe('frag-1');
    expect(node.width).toBe(200);
    expect(node.height).toBe(300);
    expect(node.crop).toEqual({
      x: 50,
      y: 80,
      w: 200,
      h: 300,
    });
  });

  // ────────────────────────────────────────────────────────────
  // 缺陷 5 §5 阶段 1b: compose/view separation. These lock the invariant BOTH
  // ways:
  //   (a) scene.view.transform === M_camera (= translate(snap.physical) ×
  //       scale(snap.renderScale)), view.target === swapchain (viewport×dpr),
  //       and scene.frame === DOCUMENT (canvas) size; and
  //   (b) layer.transform is the CAMERA-INDEPENDENT M_layer (canvas space) — the
  //       camera is NOT baked into it. If someone re-bakes the camera into
  //       layers (regressing to 缺陷 5), (b) fails; if the view/frame wiring is
  //       dropped, (a) fails.
  // ────────────────────────────────────────────────────────────
  describe('阶段 1b: compose/view separation (缺陷 5 §5)', () => {
    it('view.transform = M_camera, view.target = swapchain, frame = document', () => {
      const geometry = createMockGeometry();
      const cam: CameraState = { x: 12, y: 34, k: 1.5 };
      const dpr = 2;
      const scene = SceneAssembler.assemble({
        frame: dummyFrame,
        camera: cam,
        viewportDim,
        dpr,
        geometry,
      });

      // Independent derivation of M_camera's expected components from the real
      // snapping operator: translate(snap.physical) × scale(snap.renderScale).
      const snap = snapCanvasRect(cam, dummyFrame.canvas, dpr);
      expect(scene.view.transform.a).toBeCloseTo(snap.renderScale.x, 6);
      expect(scene.view.transform.d).toBeCloseTo(snap.renderScale.y, 6);
      expect(scene.view.transform.b).toBe(0);
      expect(scene.view.transform.c).toBe(0);
      expect(scene.view.transform.tx).toBeCloseTo(snap.physical.x, 6);
      expect(scene.view.transform.ty).toBeCloseTo(snap.physical.y, 6);

      // frame is the DOCUMENT (canvas native) size — camera-independent.
      expect(scene.frame.width).toBe(dummyFrame.canvas.w);
      expect(scene.frame.height).toBe(dummyFrame.canvas.h);

      // view.target is the swapchain physical size (viewport × dpr).
      expect(scene.view.target.width).toBe(Math.floor(viewportDim.w * dpr));
      expect(scene.view.target.height).toBe(Math.floor(viewportDim.h * dpr));
    });

    it('阶段 1b invariant: layer.transform is CAMERA-INDEPENDENT (bare M_layer)', () => {
      const geometry = createMockGeometry();
      const layer: Layer = {
        id: 'L1',
        name: 'Image',
        type: 'image',
        src: 'test.png',
        assetId: 'asset-1',
        cx: 100,
        cy: 100,
        scale: 1,
        rotation: 0,
        flip: { h: false, v: false },
        bounding: { w: 100, h: 100 },
        visible: true,
        locked: false,
        opacity: 1,
      };
      const frame: Frame = {
        ...dummyFrame,
        layers: { order: ['L1'], byId: { L1: layer } },
      };
      // Use a NON-identity camera so a re-baked M_camera×M_layer would differ
      // from the bare M_layer, making the regression detectable.
      const cam: CameraState = { x: 40, y: 50, k: 2 };
      const dpr = 2;
      const scene = SceneAssembler.assemble({
        frame,
        camera: cam,
        viewportDim,
        dpr,
        geometry,
      });

      // Mock getLayerLocalMatrix → {a:1,b:0,c:0,d:1,tx:10,ty:20}. 阶段 1b keeps the
      // camera OUT of layer.transform, so it must equal that bare matrix exactly —
      // independent of the (non-identity) camera.
      const node = scene.layers[0];
      expect(node.transform).toEqual({ a: 1, b: 0, c: 0, d: 1, tx: 10, ty: 20 });
    });
  });
});
