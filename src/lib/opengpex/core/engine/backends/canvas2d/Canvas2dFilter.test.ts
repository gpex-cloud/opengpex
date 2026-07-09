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
 * Canvas2dFilter — high-res (HighResPixelBuffer) integration tests.
 *
 * The 8-bit `ImageBitmap` path requires an actual canvas / bitmap
 * implementation, so it is exercised in-browser during Step 3 integration
 * (Worker bridge). The high-res path is pure typed-array math and can run
 * in a Node/Vitest environment directly — those code paths are the ones
 * that most affect export fidelity, so we cover them here.
 */

import { describe, expect, it } from 'vitest';

import type {
  HighResPixelBuffer,
  FilterDescriptor,
} from '@opengpex/editor/core/engine/protocol/IFilter';
import { Canvas2dFilter } from './Canvas2dFilter';

/**
 * `HighResPixelBuffer` only admits 16-bit or 32-bit precision (see spec
 * §10.2) — 8-bit ImageData travels through the `ImageBitmap` path instead.
 * We build 16-bit buffers here so the tests exercise the real export lane.
 */
function makeFlatBuffer(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a: number = 65535,
): HighResPixelBuffer {
  const stride = 4;
  const size = width * height * stride;
  const data = new Uint16Array(size);
  for (let i = 0; i < size; i += stride) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { data, width, height, bitDepth: 16, channels: stride };
}


describe('Canvas2dFilter (high-res path)', () => {
  it('leaves pixels unchanged for an empty filter chain', async () => {
    const filter = new Canvas2dFilter();
    const buf = makeFlatBuffer(4, 4, 12345, 6789, 42);
    const original = Array.from(buf.data);
    const out = (await filter.apply(buf, [])) as HighResPixelBuffer;
    expect(Array.from(out.data)).toEqual(original);
  });

  it('curves: applies an inverse LUT on a 16-bit buffer', async () => {
    const filter = new Canvas2dFilter();
    const buf = makeFlatBuffer(2, 2, 0x2000, 0x4000, 0x8000);

    // Inverse curve — every input x maps to 1-x
    const filters: FilterDescriptor[] = [
      {
        type: 'curves',
        channels: {
          rgb: [
            [0, 1],
            [1, 0],
          ],
        },
      },
    ];
    const out = (await filter.apply(buf, filters)) as HighResPixelBuffer;
    // Uint16 max is 0xFFFF; inverse of 0x2000 ≈ 0xDFFF, ± quantization slack.
    expect(out.data[0]).toBeGreaterThan(0xdff0);
    expect(out.data[0]).toBeLessThanOrEqual(0xffff);
    expect(out.data[1]).toBeGreaterThan(0xbf00);
    expect(out.data[2]).toBeLessThan(0x8100);
  });

  it('levels: clips below inputBlack to outputBlack on a 16-bit buffer', async () => {
    const filter = new Canvas2dFilter();
    const buf = makeFlatBuffer(2, 2, 100, 100, 100);
    const out = (await filter.apply(buf, [
      {
        type: 'levels',
        config: {
          inputBlack: 128,
          inputWhite: 255,
          gamma: 1,
          outputBlack: 20,
          outputWhite: 255,
        },
      },
    ])) as HighResPixelBuffer;
    // input 100 < inputBlack 128 → clip to outputBlack 20 (scaled to 16-bit).
    const expected = Math.round((20 / 255) * 65535);
    expect(Math.abs(out.data[0] - expected)).toBeLessThanOrEqual(4);
  });

  it('channelMix: swaps red and blue via matrix rows', async () => {
    const filter = new Canvas2dFilter();
    const buf = makeFlatBuffer(1, 1, 65535, 0, 0);
    const out = (await filter.apply(buf, [
      {
        type: 'channelMix',
        data: {
          red: [0, 0, 1],   // R' = B
          green: [0, 1, 0], // G' = G
          blue: [1, 0, 0],  // B' = R
        },
      },
    ])) as HighResPixelBuffer;
    expect(out.data[0]).toBe(0);       // R' was B (0)
    expect(out.data[2]).toBe(65535);   // B' was R (65535)
  });

  it('respects AbortSignal.aborted at entry', async () => {
    const filter = new Canvas2dFilter();
    const buf = makeFlatBuffer(2, 2, 100, 100, 100);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      filter.apply(buf, [{ type: 'brightness', value: 150 }], { signal: ctrl.signal }),
    ).rejects.toThrow(/aborted/);
  });

  it('supports() reports true for every documented FilterType', () => {
    const filter = new Canvas2dFilter();
    for (const t of [
      'brightness',
      'contrast',
      'saturation',
      'hueRotate',
      'blur',
      'curves',
      'levels',
      'channelMix',
      'custom',
    ] as const) {
      expect(filter.supports(t)).toBe(true);
    }
  });

  it('maxBitDepth() reports 16-bit precision', () => {
    expect(new Canvas2dFilter().maxBitDepth()).toBe(16);
  });
});
