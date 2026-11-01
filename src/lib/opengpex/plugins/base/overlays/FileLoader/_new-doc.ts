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
 * Blank-document creation helpers (pure logic, no React / no browser APIs at
 * module scope) for the FileLoader "New Document" feature.
 *
 * The creation pipeline itself lives in `commands.ts` (`cmd.create_blank`):
 * this module only owns the pure decisions — naming, size validation, unit
 * conversion, and the background-fill colour encoding — so they stay unit
 * testable in `tests/` without dragging the editor context along.
 */

import { srgbToLinear, linearToSrgb } from '@opengpex/editor/core/engine/color/trc';
import { applyMatrix3x3, getConversionMatrix } from '@opengpex/editor/core/engine/color/matrices';
import { inchesToPx, cmToPx } from '@opengpex/editor/core/files/shared/dpi';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Physical units the dialog accepts alongside raw pixels. */
export type BlankSizeUnit = 'px' | 'in' | 'mm';

export type BlankBackground = 'white' | 'black' | 'transparent' | { hex: string };

/** The SDR gamuts a new document can be tagged with (rec2020 is HDR-track only). */
export type BlankGamut = 'srgb' | 'display-p3' | 'adobe-rgb' | 'prophoto-rgb';

export interface BlankSizeLimits {
  /** Negotiated `GPUDevice.limits.maxTextureDimension2D`. */
  maxTextureDimension2D: number;
  /** Negotiated `GPUDevice.limits.maxBufferSize` (budget proxy, amber-only). */
  maxBufferSize: number;
}

export type BlankCanvasSizeVerdict =
  | { ok: true; warning?: string }
  | { ok: false; reason: string };

// ═══════════════════════════════════════════════════════════════════════════════
// Naming — `creation-{ran}`, random base36, regenerate on collision
// ═══════════════════════════════════════════════════════════════════════════════

const NAME_CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomSuffix(): string {
  // 6–8 chars: length drawn once per call, then uniform base36 draws.
  const length = 6 + Math.floor(Math.random() * 3);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += NAME_CHARSET[Math.floor(Math.random() * NAME_CHARSET.length)];
  }
  return out;
}

/**
 * Generate a collision-free `creation-{ran}` frame name. Deliberately random
 * rather than index-incrementing: no order bookkeeping, and parallel sessions
 * cannot race on a counter.
 *
 * @param existingNames - Frame names already in the workspace (exact match check).
 */
export function generateCreationName(existingNames: Iterable<string>): string {
  const taken = new Set(existingNames);
  for (let attempt = 0; attempt < 64; attempt++) {
    const candidate = `creation-${randomSuffix()}`;
    if (!taken.has(candidate)) return candidate;
  }
  // 64 collisions on a ≥36^6 space means something is deeply wrong (all names
  // taken?) — surface it rather than loop forever.
  throw new Error('Unable to generate a unique document name.');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Size — unit conversion + GPU-limit validation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert a dialog value in the given unit to whole pixels via the document
 * DPI. `px` passes through (still rounded/clamped to ≥1); `in`/`mm` delegate
 * to the shared DPI helpers (`inchesToPx` / `cmToPx`, both Math.round).
 */
export function sizeToPixels(value: number, unit: BlankSizeUnit, dpi: number): number {
  if (!isFinite(value) || value <= 0) return 0;
  const px = unit === 'px' ? Math.round(value) : unit === 'in' ? inchesToPx(value, dpi) : cmToPx(value / 10, dpi);
  return Math.max(1, px);
}

/**
 * Validate a requested canvas size against the negotiated GPU limits.
 *
 * Hard gate: either dimension exceeding `maxTextureDimension2D` would force
 * per-source tiling on every draw of this document's base layer — refused.
 * Soft gate (amber, still allowed): the composite plan needs ~`w*h*8` bytes
 * (rgba16float) × 2 resident targets; past `maxBufferSize` the engine keeps
 * working but degrades to ROI streaming, so the user deserves a heads-up.
 */
export function validateBlankCanvasSize(w: number, h: number, limits: BlankSizeLimits): BlankCanvasSizeVerdict {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    return { ok: false, reason: 'Size must be at least 1 × 1 pixels.' };
  }
  const { maxTextureDimension2D, maxBufferSize } = limits;
  if (w > maxTextureDimension2D || h > maxTextureDimension2D) {
    return {
      ok: false,
      reason: `Size exceeds this device's maximum texture dimension (${maxTextureDimension2D} px).`,
    };
  }
  const compositeBytes = w * h * 8 * 2; // rgba16float × resident composite targets
  if (compositeBytes > maxBufferSize) {
    return {
      ok: true,
      warning: 'This size exceeds the GPU buffer budget — the canvas will stream at reduced performance.',
    };
  }
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Background fill — colour encoding per target gamut / bit depth
// ═══════════════════════════════════════════════════════════════════════════════

/** Parse `#rrggbb` to 0–255 channel triple; throws on malformed input. */
export function parseHexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Invalid hex colour: ${hex}`);
  const int = parseInt(m[1], 16);
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
}

/**
 * Encode one background colour into the target gamut's sample domain.
 *
 * The container we synthesize is re-ingested by the same decision matrix as
 * any real file, so the samples must match what those rows expect:
 *  - `srgb` / `display-p3` rows declare `trc:'srgb-trc'` → samples are
 *    gamma-encoded: sRGB decode → linear → gamut matrix → sRGB-TRC re-encode.
 *  - `adobe-rgb` / `prophoto-rgb` rows declare `trc:'linear'` → samples are
 *    raw linear values in those primaries: decode → matrix, no re-encode.
 * White and black are fixed points of every branch, so the common backgrounds
 * are bit-exact regardless of gamut.
 *
 * @returns channels quantized to the requested bit depth (RGB only; alpha is
 * uniform across the canvas and handled by the caller).
 */
export function encodeFillChannels(
  hex: string,
  gamut: BlankGamut,
  bitDepth: 8 | 16,
): { r: number; g: number; b: number } {
  const [r8, g8, b8] = parseHexRgb(hex);
  const max = bitDepth === 8 ? 255 : 65535;
  const encode = (linear: number): number => Math.round((gamut === 'adobe-rgb' || gamut === 'prophoto-rgb' ? linear : linearToSrgb(linear)) * max);

  // sRGB at 8-bit is the identity round-trip — skip the gamma bounce to keep
  // the samples bit-exact with what the user picked.
  if (gamut === 'srgb' && bitDepth === 8) {
    return { r: r8, g: g8, b: b8 };
  }
  if (gamut === 'srgb') {
    return { r: encode(srgbToLinear(r8 / 255)), g: encode(srgbToLinear(g8 / 255)), b: encode(srgbToLinear(b8 / 255)) };
  }
  const matrix = getConversionMatrix('srgb', gamut);
  if (!matrix) throw new Error(`No conversion matrix for gamut: ${gamut}`);
  const [lr, lg, lb] = applyMatrix3x3(srgbToLinear(r8 / 255), srgbToLinear(g8 / 255), srgbToLinear(b8 / 255), matrix);
  return { r: encode(lr), g: encode(lg), b: encode(lb) };
}

/**
 * Build the uniform-fill RGBA sample buffer for the blank canvas.
 *
 * 16-bit canvases ship as a `RawPixelSource` (naked `Uint16Array` samples)
 * because the browser canvas encoder cannot emit 16-bit PNG — this is the
 * same lane the egest pipeline uses for high-depth output. Alpha is applied
 * uniformly: transparent canvases are fully transparent (samples zeroed).
 */
export function buildFillBuffer(
  w: number,
  h: number,
  background: BlankBackground,
  gamut: BlankGamut,
  bitDepth: 8 | 16,
): Uint8Array | Uint16Array {
  const transparent = background === 'transparent';
  const max = bitDepth === 8 ? 255 : 65535;
  // White and black are fixed points of every gamut/TRC branch (see
  // `encodeFillChannels`), so the presets never incur a colour conversion.
  const channels = transparent
    ? { r: 0, g: 0, b: 0 }
    : encodeFillChannels(background === 'white' ? '#ffffff' : background === 'black' ? '#000000' : background.hex, gamut, bitDepth);
  const alpha = transparent ? 0 : max;

  const buffer = bitDepth === 8
    ? new Uint8Array(w * h * 4)
    : new Uint16Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    buffer[o] = channels.r;
    buffer[o + 1] = channels.g;
    buffer[o + 2] = channels.b;
    buffer[o + 3] = alpha;
  }
  return buffer;
}
