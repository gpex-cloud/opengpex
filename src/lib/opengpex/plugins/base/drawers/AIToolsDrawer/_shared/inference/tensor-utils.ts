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
 * Shared Inference Backend — Tensor Utilities
 *
 * Pure functions for converting between RGBA pixel data and NCHW float tensors.
 * Extracted from upscaler/worker.ts and inpaint/eraser/worker.ts to eliminate
 * code duplication across AI tool workers.
 *
 * Functions:
 *   - rgbaToNchw(): RGBA Uint8Array → RGB float32 [1, 3, H, W]
 *   - tensorToRgba(): RGB float32 tensor → RGBA Uint8Array (auto-detect range & layout)
 *   - detectOutputRange(): Sample tensor values to determine scale/offset
 *   - detectLayout(): Determine NCHW vs NHWC from tensor dimensions
 *
 * ⚠️ This file is imported by Web Workers — keep it free of DOM/React deps.
 */

// ─── RGBA → NCHW ────────────────────────────────────────────────────────────

/**
 * Convert RGBA Uint8Array to RGB float32 NCHW tensor [1, 3, H, W].
 * Values are normalized to [0, 1].
 *
 * @param rgba - Input RGBA pixel data (width × height × 4 bytes)
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @returns Float32Array in NCHW layout [1, 3, H, W] with values in [0, 1]
 */
export function rgbaToNchw(rgba: Uint8Array, width: number, height: number): Float32Array {
  const pixels = width * height;
  const inputF32 = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    inputF32[i] = rgba[i * 4] / 255.0;               // R
    inputF32[pixels + i] = rgba[i * 4 + 1] / 255.0;  // G
    inputF32[2 * pixels + i] = rgba[i * 4 + 2] / 255.0; // B
  }
  return inputF32;
}

// ─── RGBA f32 ↔ NCHW (precision-preserving path) ─────────────────────────────

/**
 * Convert interleaved RGBA float32 [0, 1] pixels to RGB float32 NCHW [1, 3, H, W].
 *
 * Precision-preserving variant of {@link rgbaToNchw}: the input is ALREADY
 * float32 in [0, 1] (e.g. decoded from 16-bit naked pixels divided by 65535),
 * so no quantization happens on the way in. The model's tensor domain is
 * unchanged — this only removes the two 8-bit quantization steps at the
 * pipeline's ends, not the [0, 1] contract itself.
 *
 * @param rgba - Input interleaved RGBA float32 pixels, length = width × height × 4
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @returns Float32Array in NCHW layout [1, 3, H, W] with values in [0, 1]
 */
export function nchwFromRasterF32(rgba: Float32Array, width: number, height: number): Float32Array {
  const pixels = width * height;
  const nchw = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    nchw[i] = rgba[i * 4];                  // R
    nchw[pixels + i] = rgba[i * 4 + 1];     // G
    nchw[2 * pixels + i] = rgba[i * 4 + 2]; // B
  }
  return nchw;
}

/**
 * Convert an RGB float32 NCHW output tensor back to interleaved RGBA float32
 * [0, 1] pixels (alpha forced to 1).
 *
 * Precision-preserving counterpart of {@link tensorToRgba}: the denoiser model
 * family (NAFNet et al.) is trained to emit [0, 1] sRGB-encoded values, so the
 * range is FIXED here — no sampling-based range detection, no rounding, no
 * clamping to 255 steps. Callers encode the result to their target depth
 * (÷65535 inverse for 16-bit, ×255 for 8-bit).
 *
 * @param data - Output tensor float data (3-channel RGB)
 * @param dims - Tensor dimensions (e.g. [1, 3, H, W] or [1, H, W, 3])
 * @returns Object with interleaved RGBA float32 pixels and resolved width/height
 */
export function rasterFromNchwF32(
  data: Float32Array,
  dims: number[],
): { rgba: Float32Array; width: number; height: number } {
  const layout = detectLayout(dims);
  let width: number;
  let height: number;
  if (layout === 'nchw') {
    height = dims[2];
    width = dims[3];
  } else {
    height = dims[1];
    width = dims[2];
  }
  const outPixels = width * height;
  const rgba = new Float32Array(outPixels * 4);

  if (layout === 'nchw') {
    for (let i = 0; i < outPixels; i++) {
      rgba[i * 4] = data[i];
      rgba[i * 4 + 1] = data[outPixels + i];
      rgba[i * 4 + 2] = data[2 * outPixels + i];
      rgba[i * 4 + 3] = 1;
    }
  } else {
    for (let i = 0; i < outPixels; i++) {
      rgba[i * 4] = data[i * 3];
      rgba[i * 4 + 1] = data[i * 3 + 1];
      rgba[i * 4 + 2] = data[i * 3 + 2];
      rgba[i * 4 + 3] = 1;
    }
  }
  return { rgba, width, height };
}

// ─── Output Range Detection ──────────────────────────────────────────────────

/**
 * Detect the value range of an output tensor by sampling.
 *
 * Different ONNX model exports use different output ranges:
 *   - [0, 1]: normalized float → scale=255, offset=0
 *   - [0, 255]: already pixel range → scale=1, offset=0
 *   - [-1, 1]: tanh output → scale=127.5, offset=127.5
 *
 * @param data - Output tensor float data
 * @returns Object with `scale` and `offset` for converting to [0, 255]
 */
export function detectOutputRange(data: Float32Array): { scale: number; offset: number } {
  let minVal = Infinity, maxVal = -Infinity;
  const sampleCount = Math.min(1000, data.length);
  for (let i = 0; i < sampleCount; i++) {
    const v = data[i];
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }

  if (maxVal > 2.0 && maxVal <= 255.0) {
    // Already in [0, 255] range
    return { scale: 1.0, offset: 0.0 };
  } else if (minVal < -0.5) {
    // [-1, 1] range — shift to [0, 1] then scale
    return { scale: 127.5, offset: 127.5 };
  }
  // [0, 1] standard — scale = 255, offset = 0
  return { scale: 255.0, offset: 0.0 };
}

// ─── Layout Detection ────────────────────────────────────────────────────────

/**
 * Detect tensor layout from dimensions.
 *
 * - NCHW: dims[1] === 3 (channels in position 1)
 * - NHWC: dims[3] === 3 (channels in last position)
 *
 * @param dims - Tensor dimensions array (e.g. [1, 3, H, W] or [1, H, W, 3])
 * @returns 'nchw' or 'nhwc'
 */
export function detectLayout(dims: number[]): 'nchw' | 'nhwc' {
  if (dims.length === 4 && dims[1] === 3) return 'nchw';
  return 'nhwc';
}

// ─── Tensor → RGBA ───────────────────────────────────────────────────────────

/**
 * Convert an RGB float32 output tensor to RGBA Uint8Array.
 *
 * Automatically detects:
 *   - Layout (NCHW vs NHWC) from tensor dimensions
 *   - Value range ([0,1], [0,255], [-1,1]) by sampling
 *
 * @param data - Output tensor float data (3-channel RGB)
 * @param dims - Tensor dimensions (e.g. [1, 3, H, W] or [1, H, W, 3])
 * @returns Object with RGBA Uint8Array and resolved width/height
 */
export function tensorToRgba(
  data: Float32Array,
  dims: number[],
): { rgba: Uint8Array; width: number; height: number } {
  const layout = detectLayout(dims);
  const { scale, offset } = detectOutputRange(data);

  let width: number;
  let height: number;

  if (layout === 'nchw') {
    // [1, 3, H, W]
    height = dims[2];
    width = dims[3];
  } else {
    // [1, H, W, 3]
    height = dims[1];
    width = dims[2];
  }
  const outPixels = width * height;

  const rgba = new Uint8Array(outPixels * 4);

  if (layout === 'nchw') {
    for (let i = 0; i < outPixels; i++) {
      const r = data[i] * scale + offset;
      const g = data[outPixels + i] * scale + offset;
      const b = data[2 * outPixels + i] * scale + offset;
      rgba[i * 4] = Math.max(0, Math.min(255, Math.round(r)));
      rgba[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(g)));
      rgba[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(b)));
      rgba[i * 4 + 3] = 255;
    }
  } else {
    for (let i = 0; i < outPixels; i++) {
      const r = data[i * 3] * scale + offset;
      const g = data[i * 3 + 1] * scale + offset;
      const b = data[i * 3 + 2] * scale + offset;
      rgba[i * 4] = Math.max(0, Math.min(255, Math.round(r)));
      rgba[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(g)));
      rgba[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(b)));
      rgba[i * 4 + 3] = 255;
    }
  }

  return { rgba, width, height };
}
