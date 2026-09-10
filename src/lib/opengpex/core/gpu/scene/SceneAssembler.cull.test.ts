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
 * SceneAssembler.cull.test.ts — WP-4 / 缺陷 5 §5 阶段 1b CPU coarse-culling.
 *
 * A layer whose world AABB lies fully outside the CANVAS (document) bounds must
 * not be packed into `Scene.layers` (and therefore not uploaded / drawn) — the
 * off-canvas scratch area is not composited (画板外不显示). Partially visible
 * layers must survive. Culling is against the canvas (camera-independent), NOT
 * the viewport, so compose-caching stays valid under pan/zoom.
 *
 * World space is centered at the canvas center (getLayerWorldMatrix convention),
 * so the canvas rect is {-w/2, -h/2, w, h}.
 */

import { describe, it, expect, vi } from 'vitest';
import { SceneAssembler } from './SceneAssembler';
import type { Frame, CameraState, Dimensions, GeometryService, Layer, Rect } from '@opengpex/editor/core/types';

/** Rect intersection matching the real geometry operator's semantics. */
function rectIntersection(r1: Rect, r2: Rect): Rect | null {
  const x1 = Math.max(r1.x, r2.x);
  const y1 = Math.max(r1.y, r2.y);
  const x2 = Math.min(r1.x + r1.w, r2.x + r2.w);
  const y2 = Math.min(r1.y + r1.h, r2.y + r2.h);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Geometry mock with the culling APIs. 缺陷 5 §5 阶段 1b culls against the CANVAS
 * (derived internally by SceneAssembler as {-w/2,-h/2,w,h}±pad), so this mock no
 * longer needs `camera.getViewportWorldRect`. The world AABB is derived from the
 * layer's `cx/cy/bounding` (world space centered at canvas center).
 */
function createCullingGeometry(): GeometryService {
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
    space: {
      getLayerBoundingBox: (l: Layer) => ({
        x: l.cx - l.bounding.w / 2,
        y: l.cy - l.bounding.h / 2,
        w: l.bounding.w,
        h: l.bounding.h,
      }),
      getRectIntersection: (r1: Rect, r2: Rect) => rectIntersection(r1, r2),
    },
  } as unknown as GeometryService;
}

function makeImageLayer(id: string, cx: number, cy: number, w = 100, h = 100): Layer {
  return {
    id,
    name: id,
    type: 'image',
    src: `${id}.png`,
    assetId: `asset-${id}`,
    cx,
    cy,
    scale: 1,
    rotation: 0,
    flip: { h: false, v: false },
    bounding: { w, h },
    visible: true,
    locked: false,
    opacity: 1,
  } as unknown as Layer;
}

describe('SceneAssembler WP-4 / 缺陷 5 §5 阶段 1b canvas culling', () => {
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
  // Canvas 800×600 → world canvas rect {-400,-300,800,600}: x∈[-400,400], y∈[-300,300].

  it('excludes a layer whose world AABB is fully outside the CANVAS', () => {
    const inside = makeImageLayer('inside', 0, 0); // canvas center
    const outside = makeImageLayer('outside', 5000, 5000); // far off-canvas

    const frame: Frame = {
      ...dummyFrame,
      layers: { order: ['inside', 'outside'], byId: { inside, outside } },
    };

    const scene = SceneAssembler.assemble({
      frame,
      camera: cam,
      viewportDim,
      dpr: 1,
      geometry: createCullingGeometry(),
    });

    const ids = scene.layers.map((l) => l.id);
    expect(ids).toContain('inside');
    expect(ids).not.toContain('outside');
  });

  it('keeps a partially-visible layer (no false cull at the canvas edge)', () => {
    // Centre at (390, 0) with 100×100 → spans x∈[340,440], overlaps the right
    // canvas edge (x=400). Must survive.
    const straddling = makeImageLayer('straddle', 390, 0);

    const frame: Frame = {
      ...dummyFrame,
      layers: { order: ['straddle'], byId: { straddle: straddling } },
    };

    const scene = SceneAssembler.assemble({
      frame,
      camera: cam,
      viewportDim,
      dpr: 1,
      geometry: createCullingGeometry(),
    });

    expect(scene.layers.map((l) => l.id)).toEqual(['straddle']);
  });

  it('does not upload culled layers (WP-1 协同)', () => {
    const outside = makeImageLayer('outside', 9000, 9000);
    const frame: Frame = {
      ...dummyFrame,
      layers: { order: ['outside'], byId: { outside } },
    };
    const engine = { has: vi.fn().mockReturnValue(false), upload: vi.fn() };

    SceneAssembler.assemble({
      frame,
      camera: cam,
      viewportDim,
      dpr: 1,
      geometry: createCullingGeometry(),
      engine: engine as unknown as import('../WebGpuEngine').IEngine,
    });

    expect(engine.upload).not.toHaveBeenCalled();
  });
});
