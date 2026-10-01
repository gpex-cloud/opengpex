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
 * float16.ts — IEEE 754 binary16 (half-float) packing.
 *
 * WHY THIS EXISTS: WebGPU's `rgba16float` texture format stores each channel as
 * a half-float BIT PATTERN, not a normalized integer. The ingest axis decodes
 * 16-bit sources (TIFF/PNG) to normalized `ushort` (0..65535) naked pixels; to
 * upload them into an `rgba16float` resident texture the
 * values must first be mapped to [0,1] and packed to binary16 bit patterns.
 * This is the correct terminal representation the spec chose (rgba16float is the
 * WebGPU unconditionally-guaranteed float format), NOT a lossy compromise.
 *
 * Kept dependency-free and pure so it runs identically in the Worker (where
 * decodeHighDepth packs its output) and under Node (vitest).
 *
 * WHY `Uint16Array` AND NOT `Float16Array`: the f16 container throughout this
 * codebase is a `Uint16Array` of BIT PATTERNS — the element type is chosen for
 * its 16-bit width (which is what `bytesPerRow` and `writeTexture` care about),
 * not to claim the values are integers. `Float16Array` would be the more direct
 * expression, but it is not usable here yet, for reasons that are toolchain
 * facts rather than preferences:
 *   • the vitest suite runs `environment: 'node'`, and this project's Node has
 *     neither `Float16Array` nor `Math.f16round` (both `undefined`);
 *   • TypeScript's `esnext` lib does not declare `Float16Array` either
 *     (`error TS2304`), so typing it would mean shipping a local `.d.ts`.
 * Two further costs to weigh whenever that changes: assigning into a
 * `Float16Array` rounds via the ENGINE's f16 semantics rather than
 * {@link floatToHalf}'s hand-written bit math, so every bit-exact assertion in
 * `float16.test.ts` / `resampleHighDepth.test.ts` needs re-validating; and
 * `dec:${id}` persists the bare TypedArray through IndexedDB structured clone,
 * so a stored `Float16Array` would fail to deserialise on any runtime lacking
 * the constructor, whereas `Uint16Array` always reads back. Registered as a
 * "revisit when the baseline lands" item, not a defect.
 *
 * @module core/engine/color/float16
 */

/**
 * Decode an IEEE binary16 bit pattern (0..65535 integer) back to a JS number.
 * Inverse of {@link floatToHalf}; handles subnormals, Inf and NaN. Used by the
 * export Readback path to turn `rgba16float` texels back into float values.
 */
export function halfToFloat(h: number): number {
  const sign = (h & 0x8000) >> 15;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  const s = sign ? -1 : 1;
  if (exp === 0) {
    // Subnormal (or ±0).
    return s * Math.pow(2, -14) * (frac / 1024);
  }
  if (exp === 0x1f) {
    return frac ? NaN : s * Infinity;
  }
  return s * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

// Scratch views for branch-free float32 → bit reinterpretation. Module-level
// (single-threaded JS / one Worker) so we don't reallocate per pixel.
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/**
 * Convert a JS number (float32-precision) to its IEEE binary16 bit pattern
 * (returned as a 0..65535 integer). Round-to-nearest-even, with correct
 * subnormal / overflow (→ ±Inf) / NaN handling.
 */
export function floatToHalf(value: number): number {
  f32[0] = value;
  const x = u32[0];

  const sign = (x >>> 16) & 0x8000;
  // Unbias float32 exponent (127) and rebias to float16 (15).
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mantissa = x & 0x007fffff;

  if (exp >= 0x1f) {
    // Overflow / Inf / NaN → Inf (or NaN, keep a mantissa bit).
    if (((x >>> 23) & 0xff) === 0xff && mantissa !== 0) {
      return sign | 0x7e00; // NaN
    }
    return sign | 0x7c00; // Inf
  }

  if (exp <= 0) {
    // Subnormal or underflow to zero.
    if (exp < -10) {
      return sign; // too small → signed zero
    }
    // Add the implicit leading 1 and shift into subnormal range with rounding.
    mantissa |= 0x00800000;
    const shift = 14 - exp;
    const halfMantissa = mantissa >>> shift;
    // Round to nearest even.
    const remainder = mantissa & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    let rounded = halfMantissa;
    if (remainder > halfway || (remainder === halfway && (halfMantissa & 1) === 1)) {
      rounded += 1;
    }
    return sign | rounded;
  }

  // Normal number. Round the 23-bit mantissa down to 10 bits (round-to-even).
  const halfMantissa = mantissa >>> 13;
  const remainder = mantissa & 0x1fff;
  const halfway = 0x1000;
  let out = (exp << 10) | halfMantissa;
  if (remainder > halfway || (remainder === halfway && (halfMantissa & 1) === 1)) {
    // Carry ripples through exponent automatically (mantissa overflow → exp+1).
    out += 1;
  }
  return sign | out;
}

/**
 * Pack normalized `ushort` RGBA pixels (0..65535 per channel) into half-float
 * bit patterns suitable for a direct `writeTexture` into an `rgba16float`
 * texture. Input length must be a multiple of 4; output has the same length.
 *
 * `src[i] / 65535` maps the integer range onto [0,1] — the same normalization
 * the GPU applies to `rgba8unorm` (`/255`), so an 8-bit and 16-bit source of the
 * same image sample to identical values, just with more precision retained.
 */
export function normalizedUint16ToFloat16(src: Uint16Array): Uint16Array {
  const out = new Uint16Array(src.length);
  const inv = 1 / 65535;
  for (let i = 0; i < src.length; i++) {
    out[i] = floatToHalf(src[i] * inv);
  }
  return out;
}

/**
 * Pack ALREADY-LINEAR float RGBA channel values DIRECTLY into half-float bit
 * patterns, with NO normalization (float32
 * TIFF branch). Input length must be a multiple of 4; output has the same
 * length.
 *
 * ⚠️ SEMANTICS ARE THE OPPOSITE OF {@link normalizedUint16ToFloat16}: a float
 * source (e.g. a 32-bit scRGB / linear-light TIFF) already carries scene-referred
 * values — `1.0` means "full", NOT "1/65535". Dividing by 65535 here would crush
 * the entire image to ~0 (the exact bug the `ushort`-cast float path had). We map
 * `src[i]` straight through `floatToHalf`, so:
 *   • no clamp — over-range wide-gamut / HDR values above 1.0 survive (they map to
 *     large half values or ±Inf, which `floatToHalf` handles);
 *   • negatives keep their sign bit (linear light may go slightly negative under
 *     wide-gamut primaries).
 *
 * Callers MUST route `ushort` sources to {@link normalizedUint16ToFloat16} and
 * `float`/`double` sources here — never the reverse (mixing them either ×65535
 * blows the range or ÷65535 crushes it).
 */
export function linearFloatToFloat16(src: Float32Array): Uint16Array {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    out[i] = floatToHalf(src[i]);
  }
  return out;
}
