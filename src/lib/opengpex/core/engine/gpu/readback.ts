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
 * readback.ts — GPU texture → CPU pixels staging + decode.
 *
 * Split out of `WebGpuEngine` (the export path) so the readback flow —
 * `copyTextureToBuffer` (256-aligned) → `mapAsync(READ)` → de-pad rows →
 * decode texels → quantize to the requested depth — is independently callable
 * and testable. Every readback path is a one-shot at human cadence (file
 * export, bake, the colour sampler's press-time snapshot + commit
 * micro-capture), so there is no pooling: ONE fresh `MAP_READ` buffer per
 * call, destroyed in this function's `finally` as soon as the readback is
 * decoded. A lost device rejects `mapAsync` and decode can throw on OOM —
 * either used to leak the whole staging buffer (tens to hundreds of MB) per
 * attempt, which the `finally` here forecloses.
 *
 * DELIBERATELY DEFERRED (do NOT add here):
 *   • Large-image tiling when the row-padded buffer exceeds `maxBufferSize`
 *     (TODO: split into horizontal bands, copy+map each, stitch).
 *   • TERMINAL TRC / colour-space ENCODE. The source texture is LINEAR light in
 *     `WORKING_GAMUT` (ProPhoto). This function returns LINEAR W values in the
 *     requested container; the single terminal step belongs to the codec side
 *     (`unpremultiplyEncodeGamut` / the display-track helpers), which MUST reuse
 *     the same W→target gamut projection + `linear_to_srgb` conversion as
 *     `view.wgsl` (no second encode point). f16 depth returns the raw linear
 *     half decoded to float; u8/u16 quantize the linear value as-is.
 *
 * @module core/engine/gpu/readback
 */

import { GPUBufferUsage } from '@opengpex/editor/core/engine/gpu/constants';
import { halfToFloat } from '@opengpex/editor/core/engine/color/float16';

export interface ReadbackRequest {
  readonly width: number;
  readonly height: number;
  /** Working format the source texture was created at. */
  readonly workingFormat: 'rgba16float' | 'rgba32float';
  readonly bitDepth: 8 | 16 | 32;
}

/**
 * Copy a texture's texels to CPU, de-padding the row alignment and decoding
 * to the requested output container. LINEAR values are preserved (final
 * colour encoding happens at the export codec step). Colour and alpha are
 * treated identically — a straight numeric requantization.
 */
export async function readbackToPixels(
  device: GPUDevice,
  source: GPUTexture,
  req: ReadbackRequest,
): Promise<Uint8ClampedArray | Uint16Array | Float32Array> {
  const { width, height, workingFormat } = req;

  // Read the full texture back. rgba16float = 8 bytes/texel;
  // rgba32float = 16. copyTextureToBuffer requires bytesPerRow % 256 === 0.
  const bytesPerTexel = workingFormat === 'rgba32float' ? 16 : 8;
  const bytesPerRow = Math.ceil((width * bytesPerTexel) / 256) * 256;
  const bufferSize = bytesPerRow * height;

  if (device.limits?.maxBufferSize && bufferSize > device.limits.maxBufferSize) {
    throw new Error(
      `[readback] Buffer size (${bufferSize} bytes) exceeds device maxBufferSize (${device.limits.maxBufferSize} bytes).`,
    );
  }

  let staging: GPUBuffer | undefined;
  let mappedNow = false;
  try {
    staging = device.createBuffer({
      label: 'Readback Staging',
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const encoder = device.createCommandEncoder({ label: 'Readback Encoder' });
    encoder.copyTextureToBuffer(
      { texture: source, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      { buffer: staging, offset: 0, bytesPerRow, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish()]);

    // `bufferSize` is a multiple of 256, so it satisfies mapAsync's alignment.
    await staging.mapAsync(GPUMapMode.READ, 0, bufferSize);
    mappedNow = true;
    const mapped = staging.getMappedRange(0, bufferSize);

    return decodeReadback(mapped, {
      width,
      height,
      bytesPerRow,
      workingFormat,
      bitDepth: req.bitDepth,
    });
  } finally {
    // `unmap()` is only legal on a mapped buffer, hence the flag; `destroy()`
    // is safe either way and implicitly unmaps.
    if (staging) {
      if (mappedNow) staging.unmap();
      staging.destroy();
    }
  }
}

/**
 * De-pad the row-aligned staging buffer and decode each texel to the requested
 * output container.
 */
function decodeReadback(
  mapped: ArrayBuffer,
  p: {
    width: number;
    height: number;
    bytesPerRow: number;
    workingFormat: GPUTextureFormat;
    bitDepth: 8 | 16 | 32;
  },
): Uint8ClampedArray | Uint16Array | Float32Array {
  const { width, height, bytesPerRow, workingFormat } = p;
  const rowFloats = width * 4;
  const isF32 = workingFormat === 'rgba32float';

  // Read one un-padded row of RGBA floats from the padded staging buffer.
  //
  // The f32 lane returns a VIEW, not a copy: `mapped` is already f32, so the
  // only work is skipping the 256-byte row padding, and `bytesPerRow` is a
  // multiple of 256 — hence always 4-byte aligned, which `Float32Array` over an
  // ArrayBuffer requires. The view is valid until `unmap()`, which happens after
  // every caller below has consumed it, so this never escapes.
  //
  // It used to `.slice()` here. That was not needed by ANY lane — the 8/16-bit
  // lanes only read `rowF[i]`, and the 32-bit lane immediately `out.set()`s the
  // row, so the slice made it copy the same data twice and allocate one throwaway
  // Float32Array per row. Invisible in `export()` (a one-shot user action), but
  // the colour sampler put this on an interactive path: 92ms of main-thread copy
  // per 4096×4096 capture, half of it pure waste.
  const readRowFloats = (row: number): Float32Array => {
    if (isF32) {
      return new Float32Array(mapped, row * bytesPerRow, rowFloats);
    }
    const halves = new Uint16Array(mapped, row * bytesPerRow, rowFloats);
    const out = new Float32Array(rowFloats);
    for (let i = 0; i < rowFloats; i++) out[i] = halfToFloat(halves[i]);
    return out;
  };

  if (p.bitDepth === 32) {
    const need = width * height * 4;
    const out = new Float32Array(need);
    for (let y = 0; y < height; y++) out.set(readRowFloats(y), y * rowFloats);
    return out;
  }
  if (p.bitDepth === 16) {
    const out = new Uint16Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const rowF = readRowFloats(y);
      const base = y * rowFloats;
      for (let i = 0; i < rowFloats; i++) {
        out[base + i] = Math.max(0, Math.min(65535, Math.round(rowF[i] * 65535)));
      }
    }
    return out;
  }
  // 8-bit — Uint8ClampedArray auto-clamps to [0,255].
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowF = readRowFloats(y);
    const base = y * rowFloats;
    for (let i = 0; i < rowFloats; i++) out[base + i] = Math.round(rowF[i] * 255);
  }
  return out;
}
