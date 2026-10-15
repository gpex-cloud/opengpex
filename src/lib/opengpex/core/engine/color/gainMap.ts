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
 * gainMap.ts — the gain-map HDR rebuild math (ultrawide phase C1, presentation
 * slice).
 *
 * A gain-map file (Apple `hdrgainmap` in HEIC / ISO 21496-1) ships TWO
 * renditions: an SDR base image plus a low-resolution log2 gain map. The HDR
 * rendition is RECONSTRUCTED, never stored:
 *
 *   hdr_linear = sdr_linear × 2^gain
 *   gain       = gainMin + (byte/255)^(1/γ) × (gainMax − gainMin)
 *
 * The map stores the base-2 logarithm of the HDR/SDR ratio, quantized affinely
 * onto [0, 255] between `gainMin` and `gainMax`; γ (≈1.15 on Apple captures)
 * shapes the quantization curve and is 1 for log2-linear payloads. `gainMin`
 * may be NEGATIVE (legal per ISO 21496-1): those samples darken in HDR — Apple
 * writes e.g. [-0.7749 .. 1.9743], where the negative tail keeps saturated
 * highlights from blowing out.
 *
 * ARCHITECTURE (C1): the master image is the SDR base lifted to linear f16 —
 * the gain is NEVER baked into it. The engine renders both HDR-ON and HDR-OFF
 * from that one resident line; a baked master would make OFF the CLAMPED HDR
 * rendition instead of the file's authoritative SDR base (a 2× sky clamps its
 * blue channel at white and hue-skews — real-device falsification). The
 * application therefore lives at the view pass, computed per pixel in WGSL from
 * the sampled map byte. THIS module holds the CPU statement of that math —
 * `decodeGainSample` is the single authority for the affine decode, golden-tested
 * bit-exactly, and the WGSL fragment mirrors it operation-for-operation
 * (`pow(s, 1/γ)` → affine → `exp2`). Presentation eligibility, texture caching
 * and the shader wiring live in the engine's gain-map source cache / view pass.
 *
 * Export-side pair quantization (SDR+gain → file) is a later slice (C2) and is
 * deliberately absent here.
 *
 * @module core/engine/color/gainMap
 */

/**
 * Decode one quantized gain-map byte to its log2 HDR/SDR ratio — the whole
 * affine space in one place. Exported for the golden tests and for any
 * CPU-side consumer; the view-pass WGSL mirrors this exact operation order.
 *
 * @param byte quantized map sample, 0..255
 * @param gainMin map value at byte 0 (log2 ratio; may be negative)
 * @param gainMax map value at byte 255 (log2 ratio)
 * @param gamma payload gamma (1 = log2-linear; the convention Apple writes)
 */
export function decodeGainSample(
  byte: number,
  gainMin: number,
  gainMax: number,
  gamma: number,
): number {
  const s = byte / 255;
  const linear = gamma === 1 ? s : Math.pow(s, 1 / gamma);
  return gainMin + linear * (gainMax - gainMin);
}

/**
 * The HDR/SDR multiplier for one map byte: `2^decodeGainSample(...)`. Kept as a
 * named helper (not inlined by callers) so the "log2 ratio" semantics have one
 * exponentiation site; golden tests pin it against the Apple truth parameters
 * (headroom 2^1.974342 ≈ 3.93× — the value Finder reports for the same file).
 */
export function gainSampleToFactor(
  byte: number,
  gainMin: number,
  gainMax: number,
  gamma: number,
): number {
  return Math.pow(2, decodeGainSample(byte, gainMin, gainMax, gamma));
}
