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
 * highDepthSource.ts — 16-bit naked-pixel preparation for f32 denoise.
 *
 * The denoiser model's tensor domain is f32 [0, 1] sRGB-encoded
 * display-referred. For a high-depth source asset, the persisted `dec:` truth
 * (bare f16/f32 naked pixels + colour identity on the light record) is the
 * full-precision input: this module turns it into the interleaved RGBA f32
 * [0, 1] raster the f32 inference path consumes, applying the same
 * transformations the 8-bit path gets for free from the sRGB extraction
 * canvas:
 *   - decode: f16 bit patterns → JS numbers (rgba32float passes through);
 *   - crop:   selection-scoped hard-edge crop, same clamping semantics as
 *             the 8-bit crop pipeline;
 *   - gamut:  a wide-gamut source encoded in the sRGB TRC is narrowed to
 *             sRGB (sRGB-TRC decode → matrix → re-encode) because the model's
 *             training domain is sRGB — out-of-gamut colours clip, honestly.
 *
 * Sources whose dec truth is LINEAR-trc (wide-gamut TIFF/RAW/EXR lines) are
 * NOT handled here: narrowing them needs the full render pipeline's TRC +
 * filmic domain knowledge. The caller degrades those to the existing 8-bit
 * path, which reads the display proxy instead.
 *
 * ⚠️ Pure pixel math — no DOM/engine deps beyond the colour primitives.
 *
 * PLACEMENT NOTE (20261124): `narrowRasterToSrgb` deliberately lives HERE,
 * not in `engine/color`: its contract is the AI model-feed shape (source-
 * encoded raster → sRGB model domain), distinct from the readback converter
 * family in `engine/utils/readback-utils.ts` (working-LINEAR premultiplied
 * input, export/sampler consumers) and from the per-colour/per-scalar
 * helpers in `engine/color`. Revisit only when a second consumer appears.
 */

import { halfToFloat, floatToHalf } from '@opengpex/editor/core/engine/color/float16';
import { srgbToLinear, linearToSrgb, ADOBE_RGB_GAMMA, gammaToLinear } from '@opengpex/editor/core/engine/color/trc';
import { P3_TO_SRGB, ADOBE_RGB_TO_SRGB, applyMatrix3x3 } from '@opengpex/editor/core/engine/color/matrices';

/** Naked-pixel container declared by the light asset record. */
type NakedDataFormat = 'rgba16float' | 'rgba32float';

/**
 * Decode a high-depth naked RGBA buffer into interleaved RGBA float32 [0, 1].
 *
 * `rgba16float` containers hold IEEE binary16 bit patterns in a Uint16Array —
 * values are ALREADY normalized [0, 1] (the decoder normalized before packing),
 * so decoding is a pure bit-pattern→number conversion with NO divide.
 * `rgba32float` buffers are true f32 [0, 1] and pass through as a copy.
 *
 * Returns a copy in both cases — the caller owns the result and may crop/
 * transform it freely without touching the store's buffer.
 */
export function decodeNakedToF32(
  data: Uint16Array | Float32Array,
  dataFormat: NakedDataFormat,
): Float32Array {
  if (dataFormat === 'rgba32float') {
    return new Float32Array(data);
  }
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = halfToFloat(data[i]);
  }
  return out;
}


/**
 * Narrow a wide-gamut sRGB-TRC-encoded raster to sRGB in f32 precision:
 * source-TRC decode → linear-light gamut→sRGB matrix → sRGB-TRC re-encode.
 *
 * The model's training domain is sRGB-encoded display-referred, so feeding
 * other-gamut values would be out of distribution AND the output could not be
 * labelled sRGB. Out-of-sRGB-gamut colours clip to the cube edge — a real
 * mathematical loss of the narrowing, not an artifact. Alpha passes through
 * untouched.
 *
 * TRC per gamut: sRGB / Display-P3 share the piecewise sRGB curve; Adobe RGB
 * uses its own pure-gamma TRC (563/256 — `ADOBE_RGB_GAMMA`). The re-encode is
 * ALWAYS sRGB: after the matrix the pixels sit in sRGB primaries, so the
 * target domain's TRC applies — only the decode branches by source TRC.
 *
 * `srgb` gamut returns the input unchanged (same buffer — nothing to do).
 */
export function narrowRasterToSrgb(
  rgba: Float32Array,
  gamut: 'srgb' | 'display-p3' | 'adobe-rgb',
): Float32Array {
  if (gamut === 'srgb') return rgba;
  // Decode uses the SOURCE TRC; see the encode note above for the asymmetry.
  const toLinear = gamut === 'adobe-rgb'
    ? (c: number) => gammaToLinear(c, ADOBE_RGB_GAMMA)
    : srgbToLinear;
  const fromLinear = linearToSrgb;
  const matrix = gamut === 'adobe-rgb' ? ADOBE_RGB_TO_SRGB : P3_TO_SRGB;
  const out = new Float32Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const [r, g, b] = applyMatrix3x3(
      toLinear(rgba[i]),
      toLinear(rgba[i + 1]),
      toLinear(rgba[i + 2]),
      matrix,
    );
    out[i] = fromLinear(r);
    out[i + 1] = fromLinear(g);
    out[i + 2] = fromLinear(b);
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

/**
 * Encode interleaved RGBA float32 [0, 1] into the bare f16 naked container
 * (`rgba16float`): per-element IEEE binary16 bit patterns in a Uint16Array.
 * Alpha is encoded like any channel — coverage in [0, 1], no TRC involved.
 */
export function encodeRgbaF32ToF16(rgba: Float32Array): Uint16Array {
  const out = new Uint16Array(rgba.length);
  for (let i = 0; i < rgba.length; i++) {
    out[i] = floatToHalf(rgba[i]);
  }
  return out;
}

/**
 * Quantize interleaved RGBA float32 [0, 1] to a 16-bit RGBA raster
 * (round-to-nearest, clamped) — the raw-16 `EncodeSource` shape for the
 * files-layer vips PNG encoder, so a New Frame ingest can re-enter the
 * document at full depth (trunk decode restores `dec:` from a 16-bit PNG).
 */
export function quantizeRgbaF32To16(rgba: Float32Array): Uint16Array {
  const out = new Uint16Array(rgba.length);
  for (let i = 0; i < rgba.length; i++) {
    const v = rgba[i];
    out[i] = Math.max(0, Math.min(65535, Math.round(v * 65535)));
  }
  return out;
}

/**
 * Quantize interleaved RGBA float32 [0, 1] to an 8-bit RGBA byte raster
 * (round-to-nearest, clamped). Produces the 8-bit display proxy that rides
 * beside the f16 truth through the ingest path.
 */
export function quantizeRgbaF32To8(rgba: Float32Array): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i++) {
    const v = rgba[i];
    out[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  return out;
}
