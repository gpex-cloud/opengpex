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

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LEVELS,
  composeLUTs,
  expandCurvesLUTs,
  generateBrightnessContrastLUT,
  generateCurveLUT,
  generateIdentityLUT,
  generateLevelsLUT,
  normalizeChannelMatrix,
} from './lut';

// ────────────────────────────────────────────────────────────
// Identity
// ────────────────────────────────────────────────────────────

describe('generateIdentityLUT', () => {
  it('returns a length-256 Uint8ClampedArray with i → i mapping', () => {
    const lut = generateIdentityLUT(256);
    expect(lut).toBeInstanceOf(Uint8ClampedArray);
    expect(lut.length).toBe(256);
    for (let i = 0; i < 256; i++) expect(lut[i]).toBe(i);
  });

  it('returns a length-65536 Uint16Array by default at 65536 entries', () => {
    const lut = generateIdentityLUT(65536);
    expect(lut).toBeInstanceOf(Uint16Array);
    expect(lut.length).toBe(65536);
    expect(lut[0]).toBe(0);
    expect(lut[65535]).toBe(65535);
    expect(lut[32768]).toBe(32768);
  });
});

// ────────────────────────────────────────────────────────────
// Curves
// ────────────────────────────────────────────────────────────

describe('generateCurveLUT', () => {
  it('produces an identity LUT when points are the default endpoints', () => {
    const lut = generateCurveLUT(
      [
        [0, 0],
        [1, 1],
      ],
      256,
    );
    // Straight line — output equals input to within ±1 (rounding).
    for (let i = 0; i < 256; i++) {
      expect(Math.abs(lut[i] - i)).toBeLessThanOrEqual(1);
    }
  });

  it('is monotonically non-decreasing for a monotonic S-curve', () => {
    const lut = generateCurveLUT(
      [
        [0, 0],
        [0.25, 0.15],
        [0.75, 0.85],
        [1, 1],
      ],
      256,
    );
    for (let i = 1; i < 256; i++) {
      expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
    }
  });

  it('pins the endpoints to [0, 0] and [1, 1] (± quantization slack)', () => {
    const lut = generateCurveLUT(
      [
        [0, 0],
        [0.5, 0.7],
        [1, 1],
      ],
      256,
    );
    expect(lut[0]).toBe(0);
    expect(lut[255]).toBe(255);
  });

  it('does NOT overshoot ([0..255]) for aggressive shadow drops', () => {
    // A steep drop at low input would overshoot with a naïve cubic spline.
    const lut = generateCurveLUT(
      [
        [0, 0.5],
        [0.1, 0.05],
        [0.9, 0.9],
        [1, 1],
      ],
      256,
    );
    for (let i = 0; i < 256; i++) {
      expect(lut[i]).toBeGreaterThanOrEqual(0);
      expect(lut[i]).toBeLessThanOrEqual(255);
    }
  });

  it('handles duplicate x by keeping the latest control point (Photoshop-like)', () => {
    const lut = generateCurveLUT(
      [
        [0, 0],
        [0.5, 0.2],
        [0.5, 0.8], // overrides the previous 0.5
        [1, 1],
      ],
      256,
    );
    // At x=0.5 (index 128) we expect the output around 0.8 → 204.
    expect(Math.abs(lut[128] - 204)).toBeLessThanOrEqual(4);
  });
});

// ────────────────────────────────────────────────────────────
// Levels
// ────────────────────────────────────────────────────────────

describe('generateLevelsLUT', () => {
  it('is identity for the default configuration', () => {
    const lut = generateLevelsLUT(DEFAULT_LEVELS, 256);
    for (let i = 0; i < 256; i++) {
      expect(Math.abs(lut[i] - i)).toBeLessThanOrEqual(1);
    }
  });

  it('clips below inputBlack to outputBlack and above inputWhite to outputWhite', () => {
    const lut = generateLevelsLUT(
      { inputBlack: 32, inputWhite: 224, gamma: 1, outputBlack: 0, outputWhite: 255 },
      256,
    );
    for (let i = 0; i <= 32; i++) expect(lut[i]).toBe(0);
    for (let i = 224; i <= 255; i++) expect(lut[i]).toBe(255);
  });

  // Photoshop-style gamma convention: y = x^(1/gamma).
  // gamma > 1 => exponent < 1 => sqrt-like curve => midtones BRIGHTEN.
  // gamma < 1 => exponent > 1 => x² -like curve => midtones DARKEN.
  it('gamma > 1 brightens midtones (Photoshop convention)', () => {
    const identity = generateLevelsLUT(DEFAULT_LEVELS, 256);
    const bright = generateLevelsLUT({ ...DEFAULT_LEVELS, gamma: 2.0 }, 256);
    expect(bright[128]).toBeGreaterThan(identity[128]);
  });

  it('gamma < 1 darkens midtones (Photoshop convention)', () => {
    const identity = generateLevelsLUT(DEFAULT_LEVELS, 256);
    const dark = generateLevelsLUT({ ...DEFAULT_LEVELS, gamma: 0.5 }, 256);
    expect(dark[128]).toBeLessThan(identity[128]);
  });


  it('degenerate range (inputBlack >= inputWhite) hard-thresholds', () => {
    const lut = generateLevelsLUT(
      { inputBlack: 128, inputWhite: 128, gamma: 1, outputBlack: 10, outputWhite: 240 },
      256,
    );
    for (let i = 0; i < 128; i++) expect(lut[i]).toBe(10);
    for (let i = 128; i < 256; i++) expect(lut[i]).toBe(240);
  });
});

// ────────────────────────────────────────────────────────────
// Brightness / contrast
// ────────────────────────────────────────────────────────────

describe('generateBrightnessContrastLUT', () => {
  it('is identity at brightness=100 contrast=100', () => {
    const lut = generateBrightnessContrastLUT(100, 100, 256);
    for (let i = 0; i < 256; i++) {
      expect(Math.abs(lut[i] - i)).toBeLessThanOrEqual(1);
    }
  });

  it('brightness > 100 raises every non-zero value', () => {
    const b = generateBrightnessContrastLUT(150, 100, 256);
    for (let i = 1; i < 256; i++) {
      expect(b[i]).toBeGreaterThanOrEqual(i);
    }
  });

  it('contrast pivots around 0.5 (midpoint 127.5 stays put)', () => {
    const lut = generateBrightnessContrastLUT(100, 150, 256);
    // 128 is just above the pivot — its delta from itself should be tiny.
    expect(Math.abs(lut[128] - 128)).toBeLessThanOrEqual(2);
    // Highlights should be pushed up, shadows down.
    expect(lut[200]).toBeGreaterThan(200);
    expect(lut[50]).toBeLessThan(50);
  });
});

// ────────────────────────────────────────────────────────────
// Channel mixer matrix helpers
// ────────────────────────────────────────────────────────────

describe('normalizeChannelMatrix', () => {
  it('produces identity rows for the identity descriptor', () => {
    const { matrix, constant } = normalizeChannelMatrix({
      red: [1, 0, 0],
      green: [0, 1, 0],
      blue: [0, 0, 1],
    });
    expect(matrix[0]).toEqual([1, 0, 0]);
    expect(matrix[1]).toEqual([0, 1, 0]);
    expect(matrix[2]).toEqual([0, 0, 1]);
    expect(constant).toEqual([0, 0, 0]);
  });

  it('propagates the constant offset when present', () => {
    const { constant } = normalizeChannelMatrix({
      red: [1, 0, 0],
      green: [0, 1, 0],
      blue: [0, 0, 1],
      constant: [0.1, -0.2, 0.3],
    });
    expect(constant).toEqual([0.1, -0.2, 0.3]);
  });
});

// ────────────────────────────────────────────────────────────
// Curves data → per-channel LUT expansion
// ────────────────────────────────────────────────────────────

describe('expandCurvesLUTs', () => {
  it('returns null slots for absent curves', () => {
    const out = expandCurvesLUTs({ red: [[0, 0], [1, 1]] });
    expect(out.rgb).toBeNull();
    expect(out.red).not.toBeNull();
    expect(out.green).toBeNull();
    expect(out.blue).toBeNull();
  });

  it('builds independent LUTs for rgb/red/green/blue', () => {
    const out = expandCurvesLUTs({
      rgb: [[0, 0], [1, 1]],
      red: [[0, 0], [1, 0.5]],
      green: [[0, 0.2], [1, 1]],
      blue: [[0, 0], [1, 1]],
    });
    expect(out.rgb).not.toBeNull();
    expect(out.red).not.toBeNull();
    expect(out.green).not.toBeNull();
    expect(out.blue).not.toBeNull();
    // Red curve maxes out at 0.5 → LUT[255] ≈ 127.
    expect(Math.abs((out.red as Uint8ClampedArray)[255] - 127)).toBeLessThanOrEqual(2);
    // Green curve starts at 0.2 → LUT[0] ≈ 51.
    expect(Math.abs((out.green as Uint8ClampedArray)[0] - 51)).toBeLessThanOrEqual(2);
  });
});

// ────────────────────────────────────────────────────────────
// LUT composition
// ────────────────────────────────────────────────────────────

describe('composeLUTs', () => {
  it('composes two identities into an identity', () => {
    const a = generateIdentityLUT(256);
    const b = generateIdentityLUT(256);
    const c = composeLUTs(a, b, 256);
    for (let i = 0; i < 256; i++) expect(c[i]).toBe(i);
  });

  it('inv(inv(x)) ≈ x when composing negation with itself', () => {
    // Build an "inverse" LUT: y = 255 - x
    const inv = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) inv[i] = 255 - i;
    const out = composeLUTs(inv, inv, 256);
    for (let i = 0; i < 256; i++) expect(Math.abs(out[i] - i)).toBeLessThanOrEqual(1);
  });

  it('throws when the two LUTs have mismatched lengths', () => {
    const a = generateIdentityLUT(256);
    const b = generateIdentityLUT(65536);
    expect(() => composeLUTs(a, b, 256)).toThrow(/length mismatch/);
  });
});
