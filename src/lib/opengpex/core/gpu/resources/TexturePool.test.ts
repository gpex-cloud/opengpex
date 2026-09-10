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
import {
  TexturePool,
  snapToPowerOfTwo,
  estimateTextureBytes,
} from './TexturePool';

describe('snapToPowerOfTwo', () => {
  it('clamps small dimensions to minBucket (default 64)', () => {
    expect(snapToPowerOfTwo(0)).toBe(64);
    expect(snapToPowerOfTwo(10)).toBe(64);
    expect(snapToPowerOfTwo(64)).toBe(64);
  });

  it('snaps values up to nearest power of 2', () => {
    expect(snapToPowerOfTwo(65)).toBe(128);
    expect(snapToPowerOfTwo(128)).toBe(128);
    expect(snapToPowerOfTwo(300)).toBe(512);
    expect(snapToPowerOfTwo(1000)).toBe(1024);
    expect(snapToPowerOfTwo(3840)).toBe(4096);
  });
});

describe('estimateTextureBytes', () => {
  it('calculates 4 bytes/px for 8-bit formats', () => {
    expect(estimateTextureBytes(256, 256, 'rgba8unorm')).toBe(256 * 256 * 4);
    expect(estimateTextureBytes(256, 256, 'bgra8unorm')).toBe(256 * 256 * 4);
  });

  it('calculates 8 bytes/px for 16-bit float formats', () => {
    expect(estimateTextureBytes(256, 256, 'rgba16float')).toBe(256 * 256 * 8);
  });

  it('calculates 16 bytes/px for 32-bit float formats', () => {
    expect(estimateTextureBytes(256, 256, 'rgba32float')).toBe(256 * 256 * 16);
  });
});

function createMockDevice(): GPUDevice {
  let id = 0;
  return {
    createTexture: vi.fn().mockImplementation((desc: GPUTextureDescriptor) => ({
      __id: ++id,
      width: (desc.size as [number, number, number])[0],
      height: (desc.size as [number, number, number])[1],
      format: desc.format,
      usage: desc.usage,
      destroy: vi.fn(),
      createView: vi.fn().mockReturnValue({}),
    })),
  } as unknown as GPUDevice;
}

describe('TexturePool lifecycle and reuse', () => {
  it('allocates and reuses textures from bucket', () => {
    const device = createMockDevice();
    const pool = new TexturePool(device);

    // Acquire 300x200 -> snaps to 512x256
    const tex1 = pool.acquire({ width: 300, height: 200, format: 'rgba16float' });
    expect(device.createTexture).toHaveBeenCalledTimes(1);

    const stats1 = pool.getStats();
    expect(stats1.inUseCount).toBe(1);
    expect(stats1.freeCount).toBe(0);

    // Release back to pool
    pool.release(tex1);
    const stats2 = pool.getStats();
    expect(stats2.inUseCount).toBe(0);
    expect(stats2.freeCount).toBe(1);

    // Acquire another texture that fits in 512x256 -> must reuse tex1
    const tex2 = pool.acquire({ width: 400, height: 250, format: 'rgba16float' });
    expect(device.createTexture).toHaveBeenCalledTimes(1); // No new creation!
    expect(tex2).toBe(tex1);

    const stats3 = pool.getStats();
    expect(stats3.inUseCount).toBe(1);
    expect(stats3.freeCount).toBe(0);
  });

  it('evicts textures when free memory exceeds threshold', () => {
    const device = createMockDevice();
    // Set maxFreeBytes to 1 MB
    const pool = new TexturePool(device, { maxFreeBytes: 1024 * 1024 });

    // 512x512 rgba16float is 512 * 512 * 8 = 2 MB > 1 MB threshold
    const tex1 = pool.acquire({ width: 512, height: 512, format: 'rgba16float' });
    pool.release(tex1);

    // Should immediately trigger eviction because 2MB > 1MB
    const stats = pool.getStats();
    expect(stats.freeCount).toBe(0);
    expect(tex1.destroy).toHaveBeenCalled();
  });
});
