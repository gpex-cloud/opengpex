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
 * WebGpuEngine.upload.test.ts — WP-1 resident-texture / zero-transfer contract.
 *
 * Verifies core §6.3: `has()`, version/reference dedup, and the three invariants
 * (zero-transfer on pan/zoom, same-source single texture, no re-DMA when resident).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebGpuEngine } from './WebGpuEngine';

interface MockDeviceHandles {
  copyExternalImageToTexture: ReturnType<typeof vi.fn>;
  createTexture: ReturnType<typeof vi.fn>;
  destroyCounts: () => number;
}

/** Build a minimal mock GPUDevice with spies on the DMA-relevant calls. */
function makeMockDevice(): { device: unknown; handles: MockDeviceHandles } {
  let destroyed = 0;
  const copyExternalImageToTexture = vi.fn();
  const createTexture = vi.fn(() => ({
    createView: () => ({}),
    destroy: () => {
      destroyed++;
    },
  }));

  const device = {
    limits: { maxTextureDimension2D: 8192, minUniformBufferOffsetAlignment: 256 },
    features: new Set<string>(),
    lost: new Promise(() => {}),
    createBuffer: () => ({ label: 'buf', destroy: () => {} }),
    createTexture,
    createSampler: () => ({}),
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    queue: { copyExternalImageToTexture, submit: vi.fn(), writeBuffer: vi.fn() },
    destroy: () => {},
  };

  return {
    device,
    handles: { copyExternalImageToTexture, createTexture, destroyCounts: () => destroyed },
  };
}

/** Init a WebGpuEngine against a mock adapter/device via the navigator.gpu shim. */
async function initEngine(device: unknown): Promise<{ engine: WebGpuEngine; restore: () => void }> {
  const mockAdapter = {
    features: new Set<string>(),
    limits: (device as { limits: unknown }).limits,
    info: { vendor: 'mock', architecture: 'mock', device: 'mock', description: 'mock' },
    requestDevice: async () => device,
  };
  const fakeGpu = {
    requestAdapter: async () => mockAdapter,
    getPreferredCanvasFormat: () => 'bgra8unorm',
  };
  const originalGpu = (globalThis as unknown as { navigator?: { gpu?: unknown } }).navigator?.gpu;
  Object.defineProperty(globalThis, 'navigator', {
    value: { gpu: fakeGpu },
    configurable: true,
    writable: true,
  });

  const canvas = {
    width: 800,
    height: 600,
    getContext: () => ({ configure: () => {}, unconfigure: () => {} }),
  } as unknown as HTMLCanvasElement;

  const engine = new WebGpuEngine();
  await engine.init(canvas);

  const restore = () => {
    if (originalGpu !== undefined) {
      Object.defineProperty(globalThis, 'navigator', {
        value: { gpu: originalGpu },
        configurable: true,
        writable: true,
      });
    }
    engine.destroy();
  };

  return { engine, restore };
}

/** Minimal ImageBitmap stand-in (upload only reads width/height/close). */
function fakeBitmap(w = 128, h = 128): ImageBitmap {
  return { width: w, height: h, close: () => {} } as unknown as ImageBitmap;
}

describe('WebGpuEngine resident texture / zero-transfer (WP-1, §6.3)', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('has() reflects residency before and after upload', async () => {
    const { device, handles } = makeMockDevice();
    const { engine, restore } = await initEngine(device);
    cleanup = restore;

    expect(engine.has('a')).toBe(false);
    engine.upload('a', fakeBitmap());
    expect(engine.has('a')).toBe(true);
    expect(handles.copyExternalImageToTexture).toHaveBeenCalledTimes(1);
  });

  it('invariant 1: re-uploading the SAME bitmap reference does not re-DMA', async () => {
    const { device, handles } = makeMockDevice();
    const { engine, restore } = await initEngine(device);
    cleanup = restore;

    const bmp = fakeBitmap();
    engine.upload('a', bmp);
    engine.upload('a', bmp); // pan/zoom frame: identical resident asset
    engine.upload('a', bmp);

    expect(handles.copyExternalImageToTexture).toHaveBeenCalledTimes(1);
    expect(handles.createTexture).toHaveBeenCalledTimes(1);
  });

  it('re-uploads when the bitmap reference changes (pixels edited)', async () => {
    const { device, handles } = makeMockDevice();
    const { engine, restore } = await initEngine(device);
    cleanup = restore;

    engine.upload('a', fakeBitmap());
    engine.upload('a', fakeBitmap()); // new bitmap object → content changed

    expect(handles.copyExternalImageToTexture).toHaveBeenCalledTimes(2);
  });

  it('version stamp: same version is a no-op, bumped version re-transfers', async () => {
    const { device, handles } = makeMockDevice();
    const { engine, restore } = await initEngine(device);
    cleanup = restore;

    const bmpA = fakeBitmap();
    const bmpB = fakeBitmap();
    engine.upload('a', bmpA, 7);
    engine.upload('a', bmpB, 7); // version unchanged → skip even though bitmap differs
    expect(handles.copyExternalImageToTexture).toHaveBeenCalledTimes(1);

    engine.upload('a', bmpB, 8); // version bumped → re-transfer
    expect(handles.copyExternalImageToTexture).toHaveBeenCalledTimes(2);
  });

  it('invariant 2: same-source assetId shares a single texture (no duplicate DMA)', async () => {
    const { device, handles } = makeMockDevice();
    const { engine, restore } = await initEngine(device);
    cleanup = restore;

    const shared = fakeBitmap(4000, 5000);
    // Original + a cut fragment resolve to the SAME source assetId.
    engine.upload('src-hashA', shared);
    engine.upload('src-hashA', shared);

    expect(handles.createTexture).toHaveBeenCalledTimes(1);
    expect(handles.copyExternalImageToTexture).toHaveBeenCalledTimes(1);
  });

  it('release() drops residency and frees the resident texture', async () => {
    const { device, handles } = makeMockDevice();
    const { engine, restore } = await initEngine(device);
    cleanup = restore;

    engine.upload('a', fakeBitmap());
    expect(engine.has('a')).toBe(true);

    engine.release('a');
    expect(engine.has('a')).toBe(false);
    expect(handles.destroyCounts()).toBe(1);

    // After release, a subsequent upload must transfer again.
    engine.upload('a', fakeBitmap());
    expect(handles.copyExternalImageToTexture).toHaveBeenCalledTimes(2);
  });
});

