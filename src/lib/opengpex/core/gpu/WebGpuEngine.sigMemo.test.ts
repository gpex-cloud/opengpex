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
 * WebGpuEngine.sigMemo.test.ts — P1 §4 composite-signature string memo.
 *
 * The signature builder (`computeCompositeSignature`) walks every layer and
 * JSON.stringifies masks/adjustments/filters. That ran EVERY frame — including
 * cam-only frames whose `scene.layers` is the SAME array reference. This memo
 * skips the rebuild on those frames. Both-way "还原即失败" guards:
 *   • same `scene.layers` reference across frames (pan/zoom) → builder called
 *     ONCE (memo hit);
 *   • a genuine content change (new layers ref) → builder RE-RUNS;
 *   • an in-place pixel edit via `upload()` (bumps asset epoch) → builder RE-RUNS
 *     even though the layers reference is unchanged (R2 defence preserved).
 *
 * We spy on `computeCompositeSignature` (forwarding to the real impl) so
 * correctness is unchanged and only its call-count is observed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as sigModule from './scene/compositeSignature';
import { WebGpuEngine } from './WebGpuEngine';
import { RenderGraph } from './graph/RenderGraph';
import { LayerTexture } from './resources/LayerTexture';
import { MAT3_IDENTITY, type Scene, type LayerNode } from './scene/Scene';

function layer(over: Partial<LayerNode> = {}): LayerNode {
  return { id: 'L1', source: { kind: 'raster', assetId: 'a1' }, transform: MAT3_IDENTITY, opacity: 1, blendMode: 'source-over', ...over };
}

const LAYERS = [layer()];

function makeScene(over: Partial<Scene> = {}): Scene {
  return {
    frame: { width: 800, height: 600 },
    display: { channelMask: 'rgb', colorSpace: 'srgb', hdr: false },
    view: { transform: MAT3_IDENTITY, target: { width: 1600, height: 1200 } },
    layers: LAYERS,
    ...over,
  };
}

function makeMockDevice() {
  return {
    limits: { maxTextureDimension2D: 8192, minUniformBufferOffsetAlignment: 256 },
    features: new Set<string>(),
    lost: new Promise(() => {}),
    createBuffer: () => ({ label: 'buf', destroy: () => {} }),
    createTexture: () => ({ createView: () => ({}), destroy: () => {} }),
    createSampler: () => ({}),
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createCommandEncoder: () => ({ beginRenderPass: () => ({ setViewport() {}, end() {} }), finish: () => ({}) }),
    createBindGroup: () => ({}),
    queue: { submit: () => {}, writeBuffer: () => {}, copyExternalImageToTexture: () => {} },
    destroy: () => {},
  };
}

async function initEngine(engine: WebGpuEngine) {
  const mockDevice = makeMockDevice();
  const mockAdapter = {
    features: new Set<string>(),
    limits: mockDevice.limits,
    info: { vendor: 'mock', architecture: 'mock', device: 'mock', description: 'mock' },
    requestDevice: async () => mockDevice,
  };
  const fakeGpu = { requestAdapter: async () => mockAdapter, getPreferredCanvasFormat: () => 'bgra8unorm' };
  Object.defineProperty(globalThis, 'navigator', { value: { gpu: fakeGpu }, configurable: true, writable: true });
  const canvas = {
    width: 1600, height: 1200, isConnected: true,
    getContext: () => ({
      configure: () => {}, unconfigure: () => {},
      getCurrentTexture: () => ({ createView: () => ({}) }),
      canvas: { width: 1600, height: 1200, isConnected: true },
    }),
  } as unknown as HTMLCanvasElement;
  await engine.init(canvas);
  return engine;
}


describe('WebGpuEngine — signature string memo (P1 §4)', () => {
  let sigSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(RenderGraph, 'composite').mockReturnValue({
      result: new LayerTexture({ texture: { createView: () => ({}), destroy: () => {} } as unknown as GPUTexture, width: 800, height: 600, format: 'rgba16float' }),
      scratch: [],
    });
    vi.spyOn(RenderGraph, 'present').mockImplementation(() => {});
    sigSpy = vi.spyOn(sigModule, 'computeCompositeSignature');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('same layers reference across frames (pan/zoom) → signature built ONCE', async () => {
    const engine = await initEngine(new WebGpuEngine());
    try {
      engine.render(makeScene());
      const afterFirst = sigSpy.mock.calls.length;
      expect(afterFirst).toBeGreaterThanOrEqual(1);

      // Two cam-only frames: identical `layers` reference (LAYERS), only view differs.
      engine.render(makeScene({ view: { transform: { a: 2, b: 0, c: 0, d: 2, tx: 10, ty: 20 }, target: { width: 1600, height: 1200 } } }));
      engine.render(makeScene({ view: { transform: { a: 3, b: 0, c: 0, d: 3, tx: 5, ty: 9 }, target: { width: 1600, height: 1200 } } }));

      // Memo hit on both cam-only frames → NO further signature builds.
      expect(sigSpy.mock.calls.length).toBe(afterFirst);
    } finally {
      engine.destroy();
    }
  });

  it('new layers reference (content edit) → signature RE-BUILT', async () => {
    const engine = await initEngine(new WebGpuEngine());
    try {
      engine.render(makeScene());
      const afterFirst = sigSpy.mock.calls.length;
      // A brand-new layers array (opacity edit) → memo miss → recompute.
      engine.render(makeScene({ layers: [layer({ opacity: 0.5 })] }));
      expect(sigSpy.mock.calls.length).toBeGreaterThan(afterFirst);
    } finally {
      engine.destroy();
    }
  });

  it('in-place pixel edit via upload() invalidates the memo (R2 preserved)', async () => {
    const engine = await initEngine(new WebGpuEngine());
    try {
      engine.render(makeScene());
      const afterFirst = sigSpy.mock.calls.length;

      // Same layers reference, but a genuine re-transfer bumps the asset epoch.
      const bmp = { width: 10, height: 10, close() {} } as unknown as ImageBitmap;
      engine.upload('a1', bmp);
      engine.render(makeScene()); // same LAYERS ref, but epoch changed

      expect(sigSpy.mock.calls.length).toBeGreaterThan(afterFirst);
    } finally {
      engine.destroy();
    }
  });
});
