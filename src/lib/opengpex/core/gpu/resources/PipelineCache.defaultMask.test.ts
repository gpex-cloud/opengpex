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
 * PipelineCache.defaultMask.test.ts — WP-3.2 default mask initialization.
 *
 * The 1×1 dummy mask bound when a layer has no explicit mask must be written to
 * opaque white (a=255), not left as undefined VRAM (Review §4.4).
 */

import { describe, it, expect, vi } from 'vitest';
import { PipelineCache } from './PipelineCache';

describe('PipelineCache default mask (WP-3.2)', () => {
  it('initializes the default 1x1 mask to opaque white via writeTexture', () => {
    const createdTextures: Array<{ usage: number; label?: string }> = [];
    const writeTexture = vi.fn();

    const device = {
      createTexture: vi.fn((desc: { usage: number; label?: string }) => {
        createdTextures.push(desc);
        return { createView: () => ({ __mask: true }) };
      }),
      queue: { writeTexture },
    } as unknown as GPUDevice;

    const cache = new PipelineCache(device);
    const view = cache.getDefaultMaskView();
    expect(view).toBeDefined();

    // writeTexture called once with a white RGBA pixel.
    expect(writeTexture).toHaveBeenCalledTimes(1);
    const [dest, data, layout, size] = writeTexture.mock.calls[0];
    expect((dest as { texture: unknown }).texture).toBeDefined();
    expect(Array.from(data as Uint8Array)).toEqual([255, 255, 255, 255]);
    expect(layout).toEqual({ bytesPerRow: 4, rowsPerImage: 1 });
    expect(size).toEqual([1, 1, 1]);

    // Texture must declare COPY_DST so writeTexture is legal.
    const maskDesc = createdTextures.find((t) => t.label === 'Default 1x1 Dummy Mask');
    expect(maskDesc).toBeDefined();
    // COPY_DST bit must be set (value 2 in the local GPUTextureUsage shim).
    expect((maskDesc!.usage & 0b10) !== 0 || maskDesc!.usage >= 2).toBe(true);
  });

  it('caches the default mask view (single allocation + single write)', () => {
    const writeTexture = vi.fn();
    const device = {
      createTexture: vi.fn(() => ({ createView: () => ({}) })),
      queue: { writeTexture },
    } as unknown as GPUDevice;

    const cache = new PipelineCache(device);
    const v1 = cache.getDefaultMaskView();
    const v2 = cache.getDefaultMaskView();
    expect(v1).toBe(v2);
    expect(writeTexture).toHaveBeenCalledTimes(1);
  });
});

describe('PipelineCache sampler selection (缺陷 3 / §3)', () => {
  function makeCache() {
    const created: Array<{ magFilter?: string; label?: string }> = [];
    const device = {
      createSampler: vi.fn((desc: { magFilter?: string; label?: string }) => {
        created.push(desc);
        return { __sampler: desc.magFilter, label: desc.label };
      }),
    } as unknown as GPUDevice;
    return { cache: new PipelineCache(device), created };
  }

  it('builds distinct linear and nearest samplers, each cached', () => {
    const { cache, created } = makeCache();
    const lin1 = cache.getLinearSampler();
    const lin2 = cache.getLinearSampler();
    const near1 = cache.getNearestSampler();
    const near2 = cache.getNearestSampler();

    expect(lin1).toBe(lin2); // cached
    expect(near1).toBe(near2); // cached
    expect(lin1).not.toBe(near1);
    expect((lin1 as { __sampler: string }).__sampler).toBe('linear');
    expect((near1 as { __sampler: string }).__sampler).toBe('nearest');
    // Exactly two samplers created (one per kind).
    expect(created.filter((d) => d.magFilter === 'linear').length).toBe(1);
    expect(created.filter((d) => d.magFilter === 'nearest').length).toBe(1);
  });

  it('getSamplerForScale: magnify (>=1) → nearest, minify (<1) → linear', () => {
    const { cache } = makeCache();
    const nearest = cache.getNearestSampler();
    const linear = cache.getLinearSampler();

    // Boundary: exactly 1.0 counts as magnify → nearest (crisp 1:1 pixels).
    expect(cache.getSamplerForScale(1)).toBe(nearest);
    expect(cache.getSamplerForScale(4)).toBe(nearest);
    expect(cache.getSamplerForScale(0.999)).toBe(linear);
    expect(cache.getSamplerForScale(0.25)).toBe(linear);
  });
});

