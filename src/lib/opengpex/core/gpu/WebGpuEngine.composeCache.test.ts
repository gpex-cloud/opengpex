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
 * WebGpuEngine.composeCache.test.ts — 缺陷 5 §5 阶段 2 compose-once/view-many.
 *
 * Both-way "还原即失败" guards at the ENGINE level:
 *   • view-only change (pan/zoom) → composite SKIPPED, present replayed;
 *   • content change (opacity/order/…) → composite RE-RUN;
 *   • document size change → composite texture rebuilt.
 *
 * We spy on `RenderGraph.composite` / `RenderGraph.present` to observe the
 * decision without needing a real GPU.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebGpuEngine } from './WebGpuEngine';
import { RenderGraph } from './graph/RenderGraph';
import { LayerTexture } from './resources/LayerTexture';
import { MAT3_IDENTITY, type Scene, type LayerNode } from './scene/Scene';

function layer(over: Partial<LayerNode> = {}): LayerNode {
  return {
    id: 'L1',
    source: { kind: 'raster', assetId: 'a1' },
    transform: MAT3_IDENTITY,
    opacity: 1,
    blendMode: 'source-over',
    ...over,
  };
}

function makeScene(over: Partial<Scene> = {}): Scene {
  return {
    frame: { width: 800, height: 600 },
    display: { channelMask: 'rgb', colorSpace: 'srgb', hdr: false },
    view: { transform: MAT3_IDENTITY, target: { width: 1600, height: 1200 } },
    layers: [layer()],
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
  const fakeGpu = {
    requestAdapter: async () => mockAdapter,
    getPreferredCanvasFormat: () => 'bgra8unorm',
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { gpu: fakeGpu },
    configurable: true,
    writable: true,
  });
  const canvas = {
    width: 1600,
    height: 1200,
    isConnected: true,
    getContext: () => ({
      configure: () => {},
      unconfigure: () => {},
      getCurrentTexture: () => ({ createView: () => ({}) }),
      canvas: { width: 1600, height: 1200, isConnected: true },
    }),
  } as unknown as HTMLCanvasElement;
  await engine.init(canvas);
  return engine;
}

describe('WebGpuEngine — compose cache (缺陷 5 §5 阶段 2)', () => {
  let compositeSpy: ReturnType<typeof vi.spyOn>;
  let presentSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    compositeSpy = vi.spyOn(RenderGraph, 'composite').mockReturnValue({
      result: new LayerTexture({
        texture: { createView: () => ({}), destroy: () => {} } as unknown as GPUTexture,
        width: 800,
        height: 600,
        format: 'rgba16float',
      }),
      scratch: [],
    });
    presentSpy = vi.spyOn(RenderGraph, 'present').mockImplementation(() => {});
  });

  afterEach(() => {
    compositeSpy.mockRestore();
    presentSpy.mockRestore();
  });

  it('pan/zoom (view-only change) SKIPS composite but presents every frame', async () => {
    const engine = await initEngine(new WebGpuEngine());
    try {
      engine.render(makeScene());
      expect(compositeSpy).toHaveBeenCalledTimes(1);
      expect(presentSpy).toHaveBeenCalledTimes(1);

      engine.render(makeScene({ view: { transform: { a: 2, b: 0, c: 0, d: 2, tx: 10, ty: 20 }, target: { width: 1600, height: 1200 } } }));
      engine.render(makeScene({ view: { transform: { a: 2, b: 0, c: 0, d: 2, tx: 99, ty: 5 }, target: { width: 1600, height: 1200 } } }));

      expect(compositeSpy).toHaveBeenCalledTimes(1); // STILL 1 — cache reused
      expect(presentSpy).toHaveBeenCalledTimes(3); // every frame presents
    } finally {
      engine.destroy();
    }
  });

  it('content change (opacity) RE-COMPOSITES', async () => {
    const engine = await initEngine(new WebGpuEngine());
    try {
      engine.render(makeScene());
      expect(compositeSpy).toHaveBeenCalledTimes(1);
      engine.render(makeScene({ layers: [layer({ opacity: 0.5 })] }));
      expect(compositeSpy).toHaveBeenCalledTimes(2);
    } finally {
      engine.destroy();
    }
  });

  it('identical content across frames RE-USES the cache', async () => {
    const engine = await initEngine(new WebGpuEngine());
    try {
      engine.render(makeScene());
      engine.render(makeScene()); // brand-new but structurally-equal scene
      expect(compositeSpy).toHaveBeenCalledTimes(1);
      expect(presentSpy).toHaveBeenCalledTimes(2);
    } finally {
      engine.destroy();
    }
  });

  it('document size change REBUILDS (re-composites) the cache', async () => {
    const engine = await initEngine(new WebGpuEngine());
    try {
      engine.render(makeScene());
      expect(compositeSpy).toHaveBeenCalledTimes(1);
      engine.render(makeScene({ frame: { width: 1024, height: 768 } }));
      expect(compositeSpy).toHaveBeenCalledTimes(2);
    } finally {
      engine.destroy();
    }
  });
});

