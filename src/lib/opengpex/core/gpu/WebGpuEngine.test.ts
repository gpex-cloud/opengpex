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

import { describe, it, expect } from 'vitest';
import { WebGpuEngine } from './WebGpuEngine';
import { EMPTY_SCENE } from './scene/Scene';

describe('WebGpuEngine lifecycle', () => {
  it('instantiates with null capabilities before init', () => {
    const engine = new WebGpuEngine();
    expect(engine.isReady()).toBe(false);
    expect(engine.getCapabilities()).toBeNull();
    expect(engine.getTexturePool()).toBeNull();
  });

  it('rejects export() before Phase 4 Readback', async () => {
    const engine = new WebGpuEngine();
    await expect(
      engine.export(EMPTY_SCENE, { bitDepth: 8 }),
    ).rejects.toThrow('export() is not implemented yet');
  });

  it('tolerates render() calls before initialization without crashing', () => {
    const engine = new WebGpuEngine();
    expect(() => engine.render(EMPTY_SCENE)).not.toThrow();

    // With multiple layers of different blend modes
    const sceneWithLayers = {
      ...EMPTY_SCENE,
      layers: [
        {
          id: 'l1',
          source: { kind: 'raster' as const, assetId: 'a1' },
          transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
          opacity: 1,
          blendMode: 'source-over' as const,
        },
        {
          id: 'l2',
          source: { kind: 'raster' as const, assetId: 'a2' },
          transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
          opacity: 0.8,
          blendMode: 'overlay' as const,
        },
      ],
    };
    expect(() => engine.render(sceneWithLayers)).not.toThrow();
  });

  it('destroy() safely cleans up empty state', () => {
    const engine = new WebGpuEngine();
    expect(() => engine.destroy()).not.toThrow();
  });

  it('attachCanvas() returns false before device initialization', () => {
    const engine = new WebGpuEngine();
    const fakeCanvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement;
    expect(engine.attachCanvas(fakeCanvas)).toBe(false);
  });

  it('deduplicates concurrent init() calls onto a single device initialization', async () => {
    const engine = new WebGpuEngine();
    let requestAdapterCallCount = 0;
    let requestDeviceCallCount = 0;

    const mockDevice = {
      limits: {
        maxTextureDimension2D: 8192,
        minUniformBufferOffsetAlignment: 256,
      },
      features: new Set<string>(),
      lost: new Promise(() => {}),
      createBuffer: () => ({ label: 'mockBuffer', destroy: () => {} }),
      createTexture: () => ({ createView: () => ({}) }),
      createSampler: () => ({}),
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({}),
      destroy: () => {},
    };

    const mockAdapter = {
      features: new Set<string>(),
      limits: mockDevice.limits,
      info: { vendor: 'mock', architecture: 'mock', device: 'mock', description: 'mock' },
      requestDevice: async () => {
        requestDeviceCallCount++;
        // Simulate async delay
        await new Promise((resolve) => setTimeout(resolve, 10));
        return mockDevice;
      },
    };

    const originalGpu = (globalThis as unknown as { navigator?: { gpu?: unknown } }).navigator?.gpu;
    const fakeGpu = {
      requestAdapter: async () => {
        requestAdapterCallCount++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return mockAdapter;
      },
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };

    const mockCanvas1 = {
      width: 800,
      height: 600,
      getContext: () => ({ configure: () => {}, unconfigure: () => {} }),
    } as unknown as HTMLCanvasElement;

    const mockCanvas2 = {
      width: 1000,
      height: 800,
      getContext: () => ({ configure: () => {}, unconfigure: () => {} }),
    } as unknown as HTMLCanvasElement;

    Object.defineProperty(globalThis, 'navigator', {
      value: { gpu: fakeGpu },
      configurable: true,
      writable: true,
    });

    try {
      // Launch two concurrent init() calls
      const [caps1, caps2] = await Promise.all([
        engine.init(mockCanvas1),
        engine.init(mockCanvas2),
      ]);

      expect(caps1).toBe(caps2);
      expect(requestAdapterCallCount).toBe(1);
      expect(requestDeviceCallCount).toBe(1);
      expect(engine.isReady()).toBe(true);

      // Third call after resolution should also reuse the same device
      const caps3 = await engine.init(mockCanvas1);
      expect(caps3).toBe(caps1);
      expect(requestAdapterCallCount).toBe(1);
      expect(requestDeviceCallCount).toBe(1);
    } finally {
      if (originalGpu !== undefined) {
        Object.defineProperty(globalThis, 'navigator', {
          value: { gpu: originalGpu },
          configurable: true,
          writable: true,
        });
      }
      engine.destroy();
    }
  });
});
