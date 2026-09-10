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
 * constants.ts — Runtime bitflag constants for WebGPU usages and stages.
 *
 * Provides real JavaScript object fallbacks so code runs seamlessly in
 * Node.js (Vitest) where WebGPU global namespaces are undefined.
 *
 * @module core/gpu/constants
 */

export const GPUTextureUsage = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
} as const;

export const GPUBufferUsage = {
  MAP_READ: 0x01,
  MAP_WRITE: 0x02,
  COPY_SRC: 0x04,
  COPY_DST: 0x08,
  INDEX: 0x10,
  VERTEX: 0x20,
  UNIFORM: 0x40,
  STORAGE: 0x80,
  INDIRECT: 0x100,
  QUERY_RESOLVE: 0x200,
} as const;

export const GPUShaderStage = {
  VERTEX: 0x1,
  FRAGMENT: 0x2,
  COMPUTE: 0x4,
} as const;

export const GPUColorWrite = {
  RED: 0x1,
  GREEN: 0x2,
  BLUE: 0x4,
  ALPHA: 0x8,
  ALL: 0xF,
} as const;

// Polyfill globals for test environments if missing
if (typeof globalThis !== 'undefined') {
  if (!('GPUTextureUsage' in globalThis)) {
    (globalThis as unknown as Record<string, unknown>).GPUTextureUsage = GPUTextureUsage;
  }
  if (!('GPUBufferUsage' in globalThis)) {
    (globalThis as unknown as Record<string, unknown>).GPUBufferUsage = GPUBufferUsage;
  }
  if (!('GPUShaderStage' in globalThis)) {
    (globalThis as unknown as Record<string, unknown>).GPUShaderStage = GPUShaderStage;
  }
  if (!('GPUColorWrite' in globalThis)) {
    (globalThis as unknown as Record<string, unknown>).GPUColorWrite = GPUColorWrite;
  }
}
