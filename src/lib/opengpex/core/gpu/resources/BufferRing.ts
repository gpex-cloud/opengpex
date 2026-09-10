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
 * BufferRing.ts — Ring buffer for dynamic per-layer uniforms (spec §4.4).
 *
 * Allocates slots inside a shared GPUBuffer, advancing a write cursor aligned
 * to `minUniformBufferOffsetAlignment` (typically 256 bytes). Avoids creating
 * new `GPUBuffer` allocations per-layer / per-frame, eliminating GC pauses.
 *
 * @module core/gpu/resources/BufferRing
 */

import { GPUBufferUsage } from '../constants';

export interface BufferSlot {
  readonly buffer: GPUBuffer;
  readonly offset: number;
  readonly size: number;
}

export class BufferRing {
  private readonly buffer: GPUBuffer;
  private readonly alignment: number;
  private cursor = 0;
  private isDestroyed = false;

  constructor(
    readonly device: GPUDevice,
    readonly capacity = 64 * 1024, // 64 KB default ring capacity
    usage = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  ) {
    this.alignment = Math.max(256, device.limits?.minUniformBufferOffsetAlignment ?? 256);
    this.buffer = device.createBuffer({
      size: capacity,
      usage,
      label: 'BufferRing Uniform Buffer',
    });
  }

  /**
   * Allocate an aligned slot in the ring buffer.
   * Wraps around to offset 0 when remaining capacity is exceeded.
   */
  allocate(size: number): BufferSlot {
    const alignedOffset = Math.ceil(this.cursor / this.alignment) * this.alignment;
    if (alignedOffset + size > this.capacity) {
      // Wrap around to start of ring
      this.cursor = size;
      return {
        buffer: this.buffer,
        offset: 0,
        size,
      };
    }

    this.cursor = alignedOffset + size;
    return {
      buffer: this.buffer,
      offset: alignedOffset,
      size,
    };
  }

  /**
   * Write data into the allocated slot using device queue.
   */
  write(offset: number, data: ArrayBufferView): void {
    this.device.queue.writeBuffer(
      this.buffer,
      offset,
      data as unknown as ArrayBufferView,
    );
  }

  /**
   * Allocate an aligned slot and immediately write `data` into it.
   */
  writeSlot(data: ArrayBufferView): BufferSlot {
    const slot = this.allocate(data.byteLength);
    this.write(slot.offset, data);
    return slot;
  }

  /** Reset cursor at frame boundary. */
  reset(): void {
    this.cursor = 0;
  }

  getBuffer(): GPUBuffer {
    return this.buffer;
  }

  destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.buffer.destroy();
  }
}
