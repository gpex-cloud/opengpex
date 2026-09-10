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
import { BufferRing } from './BufferRing';

function createMockDevice(): GPUDevice {
  return {
    limits: {
      minUniformBufferOffsetAlignment: 256,
    },
    createBuffer: vi.fn().mockImplementation((desc: GPUBufferDescriptor) => ({
      size: desc.size,
      usage: desc.usage,
      destroy: vi.fn(),
    })),
    queue: {
      writeBuffer: vi.fn(),
    },
  } as unknown as GPUDevice;
}

describe('BufferRing', () => {
  it('allocates slots aligned to 256 bytes', () => {
    const device = createMockDevice();
    const ring = new BufferRing(device, 1024);

    const slot1 = ring.allocate(64);
    expect(slot1.offset).toBe(0);
    expect(slot1.size).toBe(64);

    const slot2 = ring.allocate(64);
    // Must be aligned to 256 bytes
    expect(slot2.offset).toBe(256);

    const slot3 = ring.allocate(100);
    expect(slot3.offset).toBe(512);
  });

  it('wraps around to 0 when capacity is exceeded', () => {
    const device = createMockDevice();
    // Capacity 1024 bytes: fits offsets 0, 256, 512, 768.
    const ring = new BufferRing(device, 1024);

    ring.allocate(64); // 0
    ring.allocate(64); // 256
    ring.allocate(64); // 512
    ring.allocate(64); // 768

    // Next 256-byte aligned offset would be 1024, which cannot fit 64 bytes -> wrap to 0!
    const wrappedSlot = ring.allocate(64);
    expect(wrappedSlot.offset).toBe(0);
  });

  it('writes data to device queue via writeSlot', () => {
    const device = createMockDevice();
    const ring = new BufferRing(device, 1024);

    const data = new Float32Array([1, 2, 3, 4]);
    const slot = ring.writeSlot(data);

    expect(slot.offset).toBe(0);
    expect(device.queue.writeBuffer).toHaveBeenCalledWith(
      ring.getBuffer(),
      0,
      data,
    );
  });
});
