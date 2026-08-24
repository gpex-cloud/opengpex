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
 * TRC (Transfer Characteristic) Conversion Utilities.
 *
 * Provides pure-math functions for converting pixel values between
 * sRGB gamma encoding and linear-light encoding.
 *
 * These are the building blocks for Phase B (linear-light compositing)
 * and can be used by any renderer backend (CPU / WebGL / WebGPU).
 *
 * Performance characteristics (approximate, single-threaded):
 * - LUT-based 8-bit buffer conversion: ~2ms for 4K (3840×2160) image
 * - Float32 per-pixel formula: ~5ms for 4K image
 * - WebGPU compute shader (future): ~0.1ms for 4K image
 *
 * Standards reference:
 * - IEC 61966-2-1:1999 (sRGB specification)
 * - ICC.1:2004 (ICC Profile specification)
 *
 * @module core/engine/rendering/shared/trc
 */

import type { TRC } from '@opengpex/editor/core/types';
import type { HighResPixelBuffer } from '@opengpex/editor/core/engine/protocol/IFilter';

// ────────────────────────────────────────────────────────────
// Scalar conversion functions
// ────────────────────────────────────────────────────────────

/**
 * Convert a single sRGB-encoded channel value [0, 1] to linear-light.
 *
 * Formula (IEC 61966-2-1):
 *   C_linear = (C <= 0.04045) ? C / 12.92 : ((C + 0.055) / 1.055)^2.4
 */
export function srgbToLinear(c: number): number {
  return c <= 0.04045
    ? c / 12.92
    : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Convert a single linear-light channel value [0, 1] to sRGB encoding.
 *
 * Formula (IEC 61966-2-1):
 *   C_srgb = (C <= 0.0031308) ? C * 12.92 : 1.055 * C^(1/2.4) - 0.055
 */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308
    ? c * 12.92
    : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

// ────────────────────────────────────────────────────────────
// LUT builders (pre-compute for fast 8-bit path)
// ────────────────────────────────────────────────────────────

/** Singleton cache for LUTs — built on first use, never rebuilt. */
let _srgbToLinearLUT: Float32Array | null = null;
let _linearToSrgbLUT: Uint8ClampedArray | null = null;

/**
 * Build (or return cached) 256-entry LUT: sRGB 8-bit → linear float [0, 1].
 *
 * Usage: `linearValue = lut[srgbByte]`
 */
export function getSrgbToLinearLUT(): Float32Array {
  if (_srgbToLinearLUT) return _srgbToLinearLUT;
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    lut[i] = srgbToLinear(i / 255);
  }
  _srgbToLinearLUT = lut;
  return lut;
}

/**
 * Build (or return cached) 4096-entry LUT: linear float quantized to 12-bit → sRGB 8-bit.
 *
 * Usage: `srgbByte = lut[Math.round(linearValue * 4095)]`
 *
 * 4096 entries provides sufficient precision for 8-bit output
 * (max error < 0.5 levels).
 */
export function getLinearToSrgbLUT(): Uint8ClampedArray {
  if (_linearToSrgbLUT) return _linearToSrgbLUT;
  const lut = new Uint8ClampedArray(4096);
  for (let i = 0; i < 4096; i++) {
    lut[i] = Math.round(linearToSrgb(i / 4095) * 255);
  }
  _linearToSrgbLUT = lut;
  return lut;
}

// ────────────────────────────────────────────────────────────
// Buffer-level TRC conversion (8-bit RGBA)
// ────────────────────────────────────────────────────────────

/**
 * Convert an 8-bit RGBA buffer's TRC in-place.
 *
 * Skips alpha channel (alpha is always linear in premultiplied and
 * non-premultiplied workflows).
 *
 * Uses pre-built LUTs for performance.
 *
 * @param data - Uint8ClampedArray of RGBA pixel data (from ImageData.data)
 * @param from - Current TRC of the buffer
 * @param to   - Target TRC
 */
export function convertBufferTRC(
  data: Uint8ClampedArray,
  from: TRC,
  to: TRC,
): void {
  if (from === to) return;

  const len = data.length;

  if (from === 'srgb-trc' && to === 'linear') {
    // sRGB → linear: use srgbToLinear LUT, output as 8-bit (lossy but fast for preview)
    const lut = getSrgbToLinearLUT();
    for (let i = 0; i < len; i += 4) {
      data[i]     = Math.round(lut[data[i]] * 255);
      data[i + 1] = Math.round(lut[data[i + 1]] * 255);
      data[i + 2] = Math.round(lut[data[i + 2]] * 255);
      // data[i + 3] — alpha unchanged
    }
  } else if (from === 'linear' && to === 'srgb-trc') {
    // linear → sRGB: treat input bytes as linear [0..255] → apply linearToSrgb
    for (let i = 0; i < len; i += 4) {
      data[i]     = Math.round(linearToSrgb(data[i] / 255) * 255);
      data[i + 1] = Math.round(linearToSrgb(data[i + 1] / 255) * 255);
      data[i + 2] = Math.round(linearToSrgb(data[i + 2] / 255) * 255);
      // data[i + 3] — alpha unchanged
    }
  }
}

// ────────────────────────────────────────────────────────────
// Buffer-level TRC conversion (HighRes: 16-bit / 32-bit)
// ────────────────────────────────────────────────────────────

/**
 * Convert a HighResPixelBuffer's TRC in-place.
 *
 * For Float32: direct formula application (lossless precision).
 * For Uint16: values are treated as normalized [0, 65535] → [0, 1].
 *
 * After conversion, `buf.trc` is updated to reflect the new state.
 *
 * @param buf       - The high-resolution pixel buffer to convert
 * @param targetTRC - The desired TRC after conversion
 */
export function convertHighResTRC(
  buf: HighResPixelBuffer,
  targetTRC: TRC,
): void {
  const currentTRC = buf.trc ?? 'srgb-trc';
  if (currentTRC === targetTRC) return;

  const { data, channels } = buf;
  const pixelCount = buf.width * buf.height;
  const stride = channels; // 3 or 4

  if (data instanceof Float32Array) {
    // Float32 path — direct formula, full precision
    const convertFn = (currentTRC === 'srgb-trc' && targetTRC === 'linear')
      ? srgbToLinear
      : linearToSrgb;

    for (let p = 0; p < pixelCount; p++) {
      const offset = p * stride;
      data[offset]     = convertFn(data[offset]);
      data[offset + 1] = convertFn(data[offset + 1]);
      data[offset + 2] = convertFn(data[offset + 2]);
      // Alpha (if present, index 3) — unchanged
    }
  } else {
    // Uint16 path — normalize to [0, 1], apply formula, scale back to [0, 65535]
    const MAX_U16 = 65535;
    const convertFn = (currentTRC === 'srgb-trc' && targetTRC === 'linear')
      ? srgbToLinear
      : linearToSrgb;

    for (let p = 0; p < pixelCount; p++) {
      const offset = p * stride;
      data[offset]     = Math.round(convertFn(data[offset] / MAX_U16) * MAX_U16);
      data[offset + 1] = Math.round(convertFn(data[offset + 1] / MAX_U16) * MAX_U16);
      data[offset + 2] = Math.round(convertFn(data[offset + 2] / MAX_U16) * MAX_U16);
      // Alpha (if present, index 3) — unchanged
    }
  }

  // Update the buffer's TRC metadata
  buf.trc = targetTRC;
}

// ────────────────────────────────────────────────────────────
// Utility: check if TRC conversion is needed
// ────────────────────────────────────────────────────────────

/**
 * Determine the effective TRC of a HighResPixelBuffer.
 * Returns the explicit `trc` field, or defaults to `'srgb-trc'` for
 * buffers created before Phase A (backward compatibility).
 */
export function getBufferTRC(buf: HighResPixelBuffer): TRC {
  return buf.trc ?? 'srgb-trc';
}

/**
 * Check if a TRC conversion is needed for a given filter preference.
 * Returns `true` if the buffer's TRC doesn't match the filter's preferred TRC
 * and the preference is not `'any'`.
 */
export function needsTRCConversion(
  bufferTRC: TRC,
  preferredTRC: TRC | 'any',
): boolean {
  if (preferredTRC === 'any') return false;
  return bufferTRC !== preferredTRC;
}
