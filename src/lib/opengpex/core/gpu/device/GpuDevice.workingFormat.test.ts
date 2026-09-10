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

import { describe, it, expect, afterEach } from 'vitest';
import { GpuDevice } from './GpuDevice';

/**
 * workingFormat feature-gate contract (defect log §9.1).
 *
 * WHY THIS EXISTS: the ping-pong Blend/Blit passes sample the intermediate
 * composite texture with a FILTERING sampler. WebGPU only permits that on an
 * `rgba32float` texture when the device has `float32-filterable`. Blendability
 * (`float32-blendable`) covers only the render-target/write side, NOT sampling.
 *
 * The original code chose `rgba32float` on `float32-blendable` ALONE. On Apple
 * Silicon (blendable present, filterable often absent) that produced an
 * unfilterable-float texture bound to a filtering sampler → pipeline creation
 * threw GPUValidationError → the whole frame's command buffer was dropped →
 * "select a blend mode and the canvas vanishes, only the checkerboard remains".
 *
 * INVARIANT GUARDED HERE: `workingFormat` may be `rgba32float` ONLY when BOTH
 * `float32-blendable` AND `float32-filterable` are granted. Every other
 * combination MUST stay on the unconditionally-safe `rgba16float`.
 *
 * Reverting GpuDevice to the single-feature check makes the
 * "blendable only" case below fail — this is a real regression guard, not a
 * change-detector.
 *
 * NOTE: this is a structural/negotiation guard. It does NOT replace a real
 * device-side pipeline smoke test (§6.2), which remains outstanding.
 */

/** Build a minimal fake `navigator.gpu` whose adapter exposes exactly `feats`. */
function installFakeGpu(feats: string[]): () => void {
  const mockDevice = {
    limits: { maxTextureDimension2D: 8192, minUniformBufferOffsetAlignment: 256 },
    features: new Set<string>(feats),
    lost: new Promise(() => {}),
    createBuffer: () => ({ label: 'buf', destroy: () => {} }),
    createTexture: () => ({ createView: () => ({}) }),
    createSampler: () => ({}),
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    destroy: () => {},
  };
  const mockAdapter = {
    features: new Set<string>(feats),
    limits: mockDevice.limits,
    info: { vendor: 'mock', architecture: 'mock', device: 'mock', description: 'mock' },
    requestDevice: async (desc?: { requiredFeatures?: Iterable<string> }) => {
      // Mirror a real device: only the features actually requested are granted.
      const requested = new Set<string>(desc?.requiredFeatures ?? []);
      return { ...mockDevice, features: requested };
    },
  };
  const fakeGpu = {
    requestAdapter: async () => mockAdapter,
    getPreferredCanvasFormat: () => 'bgra8unorm',
  };

  const original = (globalThis as unknown as { navigator?: unknown }).navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: { gpu: fakeGpu },
    configurable: true,
    writable: true,
  });
  return () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: original,
      configurable: true,
      writable: true,
    });
  };
}

function makeCanvas(): HTMLCanvasElement {
  return {
    width: 800,
    height: 600,
    getContext: () => ({ configure: () => {}, unconfigure: () => {} }),
  } as unknown as HTMLCanvasElement;
}

describe('GpuDevice — workingFormat feature gate (§9.1)', () => {
  let restore: (() => void) | null = null;
  let device: GpuDevice | null = null;

  afterEach(() => {
    device?.destroy();
    device = null;
    restore?.();
    restore = null;
  });

  it('uses rgba16float when NO float32 features are granted', async () => {
    restore = installFakeGpu([]);
    device = new GpuDevice();
    const caps = await device.init(makeCanvas());
    expect(caps.workingFormat).toBe('rgba16float');
  });

  it('stays on rgba16float when ONLY float32-blendable is granted (the Apple Silicon trap)', async () => {
    restore = installFakeGpu(['float32-blendable']);
    device = new GpuDevice();
    const caps = await device.init(makeCanvas());
    // Blendable alone is NOT enough — sampling the target needs filterable too.
    expect(caps.workingFormat).toBe('rgba16float');
  });

  it('stays on rgba16float when ONLY float32-filterable is granted', async () => {
    restore = installFakeGpu(['float32-filterable']);
    device = new GpuDevice();
    const caps = await device.init(makeCanvas());
    expect(caps.workingFormat).toBe('rgba16float');
  });

  it('upgrades to rgba32float ONLY when BOTH float32 features are granted', async () => {
    restore = installFakeGpu(['float32-blendable', 'float32-filterable']);
    device = new GpuDevice();
    const caps = await device.init(makeCanvas());
    expect(caps.workingFormat).toBe('rgba32float');
    // Both must be present in the negotiated set.
    expect(caps.features).toContain('float32-blendable');
    expect(caps.features).toContain('float32-filterable');
  });
});
