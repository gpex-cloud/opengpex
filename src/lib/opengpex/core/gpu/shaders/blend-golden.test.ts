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
 * blend-golden.test.ts — Color-correctness gate for the 16 blend modes (WP-0).
 *
 * ⚠️ Reference values MUST be independent of the code under test.
 *    - `w3cBlend()` / `w3cComposite()` below are transcribed directly from the
 *      W3C Compositing and Blending Level 1 spec — they DO NOT import the blend
 *      math from `blend.ts` / `blend.wgsl`. If the shader is wrong, the reference
 *      stays right and the test fails (this is exactly what the pre-existing 321
 *      tests could not do, because they compared the shader against itself).
 *
 * Two independent assertion layers:
 *    ① TS port (`portApplyBlend`, a faithful transcription of the WGSL switch)
 *       vs the independent W3C reference — proves the blend MATH is correct.
 *    ② The WGSL source string (`BLEND_WGSL`) vs the TS port — proves the shader
 *       and the port stay in lock-step (port fidelity).
 *
 * Cases MUST include semi-transparent BACKGROUND (αb < 1), not only a
 * semi-transparent foreground — this is where the Darken/Lighten hardware
 * min/max trap surfaces (see core §7.2 counter-example).
 *
 * Note: `BLEND_MODE_MAP` (a name→index table, not blend math) is imported only
 * to cross-check that WGSL `case Nu:` numbers line up with mode names. The blend
 * FORMULAS are never imported.
 *
 * @module core/gpu/shaders/blend-golden.test
 */

import { describe, it, expect } from 'vitest';
import type { LayerBlendMode } from '@opengpex/editor/core/types';
import { BLEND_MODE_MAP, BLEND_WGSL } from './blend';

// 1/255 tolerance — "pixel-identical" for an 8-bit channel.
const TOL = 1 / 255;

type Vec3 = [number, number, number];

const ALL_MODES: LayerBlendMode[] = [
  'source-over', 'multiply', 'screen', 'overlay',
  'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion',
  'hue', 'saturation', 'color', 'luminosity',
];

// ────────────────────────────────────────────────────────────
// Independent W3C Compositing Level 1 reference implementation.
// Written straight from the spec text; imports NO blend math.
// ────────────────────────────────────────────────────────────

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** W3C separable per-channel blend functions (cb = backdrop, cs = source). */
function w3cSeparableChannel(cb: number, cs: number, mode: LayerBlendMode): number {
  switch (mode) {
    case 'source-over':
      return cs;
    case 'multiply':
      return cb * cs;
    case 'screen':
      return cb + cs - cb * cs;
    case 'overlay':
      // Overlay(cb,cs) == HardLight(cs,cb); branch on backdrop.
      return cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
    case 'darken':
      return Math.min(cb, cs);
    case 'lighten':
      return Math.max(cb, cs);
    case 'color-dodge':
      if (cb === 0) return 0;
      if (cs === 1) return 1;
      return Math.min(1, cb / (1 - cs));
    case 'color-burn':
      if (cb === 1) return 1;
      if (cs === 0) return 0;
      return 1 - Math.min(1, (1 - cb) / cs);
    case 'hard-light':
      // HardLight(cb,cs); branch on source.
      return cs <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
    case 'soft-light': {
      if (cs <= 0.5) {
        return cb - (1 - 2 * cs) * cb * (1 - cb);
      }
      const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
      return cb + (2 * cs - 1) * (d - cb);
    }
    case 'difference':
      return Math.abs(cb - cs);
    case 'exclusion':
      return cb + cs - 2 * cb * cs;
    default:
      // Non-separable HSL modes handled in w3cBlend().
      return cs;
  }
}


// --- W3C non-separable (HSL) helpers, spec §Blending: Non-separable ---

function lum(c: Vec3): number {
  return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
}

function clipColor(c: Vec3): Vec3 {
  const l = lum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  let out: Vec3 = [c[0], c[1], c[2]];
  if (n < 0) {
    out = [
      l + ((out[0] - l) * l) / (l - n),
      l + ((out[1] - l) * l) / (l - n),
      l + ((out[2] - l) * l) / (l - n),
    ];
  }
  if (x > 1) {
    out = [
      l + ((out[0] - l) * (1 - l)) / (x - l),
      l + ((out[1] - l) * (1 - l)) / (x - l),
      l + ((out[2] - l) * (1 - l)) / (x - l),
    ];
  }
  return [clamp01(out[0]), clamp01(out[1]), clamp01(out[2])];
}

function setLum(c: Vec3, l: number): Vec3 {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}

function sat(c: Vec3): number {
  return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
}

/**
 * W3C SetSat via the canonical min/mid/max sort (spec pseudocode).
 * Deliberately structured differently from the WGSL 6-branch form to keep
 * this reference independent of the shader's implementation.
 */
function setSat(c: Vec3, s: number): Vec3 {
  const idx = [0, 1, 2];
  idx.sort((a, b) => c[a] - c[b]);
  const [iMin, iMid, iMax] = idx;
  const out: Vec3 = [0, 0, 0];
  if (c[iMax] > c[iMin]) {
    out[iMid] = ((c[iMid] - c[iMin]) * s) / (c[iMax] - c[iMin]);
    out[iMax] = s;
  } else {
    out[iMid] = 0;
    out[iMax] = 0;
  }
  out[iMin] = 0;
  return out;
}

/** W3C blend for all 16 modes; returns un-premultiplied blended RGB. */
function w3cBlend(cb: Vec3, cs: Vec3, mode: LayerBlendMode): Vec3 {
  switch (mode) {
    case 'hue':
      return setLum(setSat(cs, sat(cb)), lum(cb));
    case 'saturation':
      return setLum(setSat(cb, sat(cs)), lum(cb));
    case 'color':
      return setLum(cs, lum(cb));
    case 'luminosity':
      return setLum(cb, lum(cs));
    default:
      return [
        w3cSeparableChannel(cb[0], cs[0], mode),
        w3cSeparableChannel(cb[1], cs[1], mode),
        w3cSeparableChannel(cb[2], cs[2], mode),
      ];
  }
}

interface CompositeResult {
  alpha: number;
  rgbPremult: Vec3;
}

/**
 * Full W3C compositing: source `cs`/`as` over backdrop `cb`/`ab` with `mode`.
 * Returns PREMULTIPLIED output (matches the shader's `out_rgb_premult`).
 */
function w3cComposite(
  ab: number, cb: Vec3, as_: number, cs: Vec3, mode: LayerBlendMode,
): CompositeResult {
  const blended = w3cBlend(cb, cs, mode);
  const alpha = as_ + ab * (1 - as_);
  const rgbPremult: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    rgbPremult[i] =
      (1 - ab) * as_ * cs[i] +
      (1 - as_) * ab * cb[i] +
      as_ * ab * blended[i];
  }
  return { alpha, rgbPremult };
}

// ────────────────────────────────────────────────────────────
// TS port — a faithful transcription of the WGSL `apply_blend`
// switch and `fs_main` composite. Mirrors the SHADER, not the
// W3C reference above. Assertion ① compares the two.
// ────────────────────────────────────────────────────────────

function overlayCh(b: number, f: number): number {
  if (b < 0.5) return 2 * b * f;
  return 1 - 2 * (1 - b) * (1 - f);
}

function softLightCh(b: number, f: number): number {
  if (f <= 0.5) return b - (1 - 2 * f) * b * (1 - b);
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  return b + (2 * f - 1) * (d - b);
}

function colorDodgeCh(b: number, f: number): number {
  if (b <= 0) return 0;
  if (f >= 1) return 1;
  return Math.min(1, b / (1 - f));
}

function colorBurnCh(b: number, f: number): number {
  if (b >= 1) return 1;
  if (f <= 0) return 0;
  return 1 - Math.min(1, (1 - b) / f);
}

// HSL helpers mirroring blend.wgsl (independent structure from reference).
function portLum(c: Vec3): number {
  return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
}
function portClipColor(cIn: Vec3): Vec3 {
  let c: Vec3 = [cIn[0], cIn[1], cIn[2]];
  const l = portLum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  if (n < 0) {
    const denom = l - n !== 0 ? l - n : 1;
    c = [l + ((c[0] - l) * l) / denom, l + ((c[1] - l) * l) / denom, l + ((c[2] - l) * l) / denom];
  }
  if (x > 1) {
    const denom = x - l !== 0 ? x - l : 1;
    c = [
      l + ((c[0] - l) * (1 - l)) / denom,
      l + ((c[1] - l) * (1 - l)) / denom,
      l + ((c[2] - l) * (1 - l)) / denom,
    ];
  }
  return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
}
function portSetLum(c: Vec3, l: number): Vec3 {
  const d = l - portLum(c);
  return portClipColor([c[0] + d, c[1] + d, c[2] + d]);
}
function portSat(c: Vec3): number {
  return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
}
/** Mirrors the WGSL set_sat 6-branch ordering exactly. */
function portSetSat(c: Vec3, s: number): Vec3 {
  const currSat = portSat(c);
  if (currSat <= 0.00001) return [0, 0, 0];
  const r = c[0];
  const g = c[1];
  const b = c[2];
  const res: Vec3 = [0, 0, 0];
  if (r <= g && g <= b) {
    res[0] = 0; res[1] = ((g - r) * s) / currSat; res[2] = s;
  } else if (r <= b && b <= g) {
    res[0] = 0; res[2] = ((b - r) * s) / currSat; res[1] = s;
  } else if (g <= r && r <= b) {
    res[1] = 0; res[0] = ((r - g) * s) / currSat; res[2] = s;
  } else if (g <= b && b <= r) {
    res[1] = 0; res[2] = ((b - g) * s) / currSat; res[0] = s;
  } else if (b <= r && r <= g) {
    res[2] = 0; res[0] = ((r - b) * s) / currSat; res[1] = s;
  } else {
    res[2] = 0; res[1] = ((g - b) * s) / currSat; res[0] = s;
  }
  return res;
}

/** Faithful transcription of the WGSL `apply_blend` switch (bg, fg). */
function portApplyBlend(bg: Vec3, fg: Vec3, mode: LayerBlendMode): Vec3 {
  const idx = BLEND_MODE_MAP[mode];
  switch (idx) {
    case 0: // Normal
      return fg;
    case 1: // Multiply
      return [bg[0] * fg[0], bg[1] * fg[1], bg[2] * fg[2]];
    case 2: // Screen
      return [
        1 - (1 - bg[0]) * (1 - fg[0]),
        1 - (1 - bg[1]) * (1 - fg[1]),
        1 - (1 - bg[2]) * (1 - fg[2]),
      ];
    case 3: // Overlay
      return [overlayCh(bg[0], fg[0]), overlayCh(bg[1], fg[1]), overlayCh(bg[2], fg[2])];
    case 4: // Darken
      return [Math.min(bg[0], fg[0]), Math.min(bg[1], fg[1]), Math.min(bg[2], fg[2])];
    case 5: // Lighten
      return [Math.max(bg[0], fg[0]), Math.max(bg[1], fg[1]), Math.max(bg[2], fg[2])];
    case 6: // Color Dodge
      return [colorDodgeCh(bg[0], fg[0]), colorDodgeCh(bg[1], fg[1]), colorDodgeCh(bg[2], fg[2])];
    case 7: // Color Burn
      return [colorBurnCh(bg[0], fg[0]), colorBurnCh(bg[1], fg[1]), colorBurnCh(bg[2], fg[2])];
    case 8: // Hard Light — overlay_ch(fg, bg)
      return [overlayCh(fg[0], bg[0]), overlayCh(fg[1], bg[1]), overlayCh(fg[2], bg[2])];
    case 9: // Soft Light
      return [softLightCh(bg[0], fg[0]), softLightCh(bg[1], fg[1]), softLightCh(bg[2], fg[2])];
    case 10: // Difference
      return [Math.abs(bg[0] - fg[0]), Math.abs(bg[1] - fg[1]), Math.abs(bg[2] - fg[2])];
    case 11: // Exclusion
      return [
        bg[0] + fg[0] - 2 * bg[0] * fg[0],
        bg[1] + fg[1] - 2 * bg[1] * fg[1],
        bg[2] + fg[2] - 2 * bg[2] * fg[2],
      ];
    case 12: // Hue
      return portSetLum(portSetSat(fg, portSat(bg)), portLum(bg));
    case 13: // Saturation
      return portSetLum(portSetSat(bg, portSat(fg)), portLum(bg));
    case 14: // Color
      return portSetLum(fg, portLum(bg));
    case 15: // Luminosity
      return portSetLum(bg, portLum(fg));
    default:
      return fg;
  }
}

/** Mirrors the WGSL `fs_main` composite (premultiplied output). */
function portComposite(
  ab: number, cb: Vec3, as_: number, cs: Vec3, mode: LayerBlendMode,
): CompositeResult {
  const blended = portApplyBlend(cb, cs, mode);
  const alpha = as_ + ab * (1 - as_);
  const rgbPremult: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    rgbPremult[i] =
      (1 - ab) * as_ * cs[i] +
      (1 - as_) * ab * cb[i] +
      as_ * ab * blended[i];
  }
  return { alpha, rgbPremult };
}


// ────────────────────────────────────────────────────────────
// Test color fixtures — chosen to avoid exact 0/0.5/1 boundaries
// so both branches of piecewise modes are exercised unambiguously.
// ────────────────────────────────────────────────────────────

const COLOR_PAIRS: Array<{ cb: Vec3; cs: Vec3 }> = [
  { cb: [0.2, 0.4, 0.6], cs: [0.8, 0.3, 0.1] },
  { cb: [0.7, 0.65, 0.15], cs: [0.25, 0.9, 0.55] },
  { cb: [0.12, 0.88, 0.44], cs: [0.6, 0.05, 0.95] },
  { cb: [0.33, 0.33, 0.33], cs: [0.66, 0.66, 0.66] },
];

// Alpha pairs — MUST include semi-transparent background (αb < 1).
const ALPHA_PAIRS: Array<{ ab: number; as: number }> = [
  { ab: 1.0, as: 1.0 },
  { ab: 0.5, as: 1.0 }, // semi-transparent backdrop
  { ab: 0.3, as: 0.7 }, // both semi-transparent
  { ab: 0.8, as: 0.4 },
];

describe('blend-golden: TS port vs independent W3C reference (①)', () => {
  it('every mode: un-premultiplied blend matches W3C within 1/255', () => {
    for (const mode of ALL_MODES) {
      for (const { cb, cs } of COLOR_PAIRS) {
        const port = portApplyBlend(cb, cs, mode);
        const ref = w3cBlend(cb, cs, mode);
        for (let i = 0; i < 3; i++) {
          expect(
            Math.abs(port[i] - ref[i]),
            `blend mismatch mode=${mode} ch=${i} port=${port[i]} ref=${ref[i]}`,
          ).toBeLessThanOrEqual(TOL);
        }
      }
    }
  });

  it('every mode: full composite matches W3C (incl. semi-transparent backdrop)', () => {
    for (const mode of ALL_MODES) {
      for (const { cb, cs } of COLOR_PAIRS) {
        for (const { ab, as } of ALPHA_PAIRS) {
          const port = portComposite(ab, cb, as, cs, mode);
          const ref = w3cComposite(ab, cb, as, cs, mode);
          expect(Math.abs(port.alpha - ref.alpha)).toBeLessThanOrEqual(TOL);
          for (let i = 0; i < 3; i++) {
            expect(
              Math.abs(port.rgbPremult[i] - ref.rgbPremult[i]),
              `composite mismatch mode=${mode} ab=${ab} as=${as} ch=${i}`,
            ).toBeLessThanOrEqual(TOL);
          }
        }
      }
    }
  });
});

describe('blend-golden: Darken/Lighten hardware min/max trap (core §7.2)', () => {
  it('reproduces the exact §7.2 Darken counter-example (αb<1)', () => {
    // αs=1, αb=0.5, Cs=0.8, Cb=0.2 → W3C composited channel = 0.5.
    const { rgbPremult, alpha } = w3cComposite(0.5, [0.2, 0.2, 0.2], 1.0, [0.8, 0.8, 0.8], 'darken');
    expect(alpha).toBeCloseTo(1.0, 6);
    expect(rgbPremult[0]).toBeCloseTo(0.5, 6);

    // The naive hardware `min` of PREMULTIPLIED values would give 0.1 — WRONG.
    const hardwareMinPremult = Math.min(1.0 * 0.8, 0.5 * 0.2); // = 0.1
    expect(Math.abs(rgbPremult[0] - hardwareMinPremult)).toBeGreaterThan(TOL);
  });

  it('Darken/Lighten/Multiply/Screen differ from Normal when αb<1', () => {
    for (const mode of ['darken', 'lighten', 'multiply', 'screen'] as LayerBlendMode[]) {
      const cb: Vec3 = [0.2, 0.4, 0.6];
      const cs: Vec3 = [0.8, 0.3, 0.1];
      const blended = w3cComposite(0.5, cb, 0.9, cs, mode);
      const asNormal = w3cComposite(0.5, cb, 0.9, cs, 'source-over');
      const maxDelta = Math.max(
        ...blended.rgbPremult.map((v, i) => Math.abs(v - asNormal.rgbPremult[i])),
      );
      expect(maxDelta, `${mode} must NOT collapse to Normal`).toBeGreaterThan(TOL);
    }
  });
});

describe('blend-golden: WGSL source vs TS port fidelity (②)', () => {
  it('WGSL case indices align with BLEND_MODE_MAP', () => {
    for (const mode of ALL_MODES) {
      expect(BLEND_WGSL).toContain(`case ${BLEND_MODE_MAP[mode]}u:`);
    }
  });

  it('WGSL separable formulas match the TS port expressions', () => {
    const wgsl = BLEND_WGSL.replace(/\s+/g, ' ');
    expect(wgsl).toContain('return bg * fg;'); // Multiply
    expect(wgsl).toContain('return 1.0 - (1.0 - bg) * (1.0 - fg);'); // Screen
    // Darken / Lighten — un-premultiplied min/max (NOT a hardware blend op)
    expect(wgsl).toContain('return min(bg, fg);');
    expect(wgsl).toContain('return max(bg, fg);');
    expect(wgsl).toContain('return abs(bg - fg);'); // Difference
    expect(wgsl).toContain('return bg + fg - 2.0 * bg * fg;'); // Exclusion
    // Overlay uses overlay_ch(bg, ...); Hard Light uses overlay_ch(fg, ...)
    expect(wgsl).toContain('overlay_ch(bg.r, fg.r)');
    expect(wgsl).toContain('overlay_ch(fg.r, bg.r)');
    expect(wgsl).toContain('soft_light_ch(bg.r, fg.r)'); // Soft Light
  });

  it('WGSL per-channel helper formulas match the TS port', () => {
    const wgsl = BLEND_WGSL.replace(/\s+/g, ' ');
    expect(wgsl).toContain('return 2.0 * b * f;'); // overlay_ch low branch
    expect(wgsl).toContain('return 1.0 - 2.0 * (1.0 - b) * (1.0 - f);'); // overlay_ch high branch
    expect(wgsl).toContain('return b - (1.0 - 2.0 * f) * b * (1.0 - b);'); // soft_light_ch
    expect(wgsl).toContain('((16.0 * b - 12.0) * b + 4.0) * b');
    expect(wgsl).toContain('0.3 * c.r + 0.59 * c.g + 0.11 * c.b'); // HSL luma
  });

  it('WGSL HSL dispatch matches the TS port composition', () => {
    const wgsl = BLEND_WGSL.replace(/\s+/g, ' ');
    expect(wgsl).toContain('set_lum(set_sat(fg, sat(bg)), lum(bg))'); // hue
    expect(wgsl).toContain('set_lum(set_sat(bg, sat(fg)), lum(bg))'); // saturation
    expect(wgsl).toContain('set_lum(fg, lum(bg))'); // color
    expect(wgsl).toContain('set_lum(bg, lum(fg))'); // luminosity
  });
});

describe('BLEND_WGSL performance gating (环⑤ coverage 收尾)', () => {
  it('gates the expensive apply_blend behind alpha_s > 0 (skips 16-mode + HSL math for uncovered/transparent pixels)', () => {
    const wgsl = BLEND_WGSL.replace(/\s+/g, ' ');
    // The full-frame blend quad runs a fragment for EVERY frame pixel, but the
    // foreground only covers a sub-rect. apply_blend must NOT run unconditionally:
    // it should be guarded by `if (alpha_s > 0.0)` so uncovered / fully-transparent
    // pixels skip the 16-mode switch + HSL helpers. This is numerically identical
    // because `blended` is only consumed by the `alpha_s * alpha_b * blended` term,
    // which is 0 when alpha_s == 0.
    expect(wgsl).toContain('if (alpha_s > 0.0) {');
    // apply_blend is called INSIDE the guard, not before it.
    const guardIdx = wgsl.indexOf('if (alpha_s > 0.0) {');
    const applyIdx = wgsl.indexOf('apply_blend(cb, cs, blend_u.blend_mode)');
    expect(guardIdx).toBeGreaterThan(0);
    expect(applyIdx).toBeGreaterThan(guardIdx);
    // Default (uncovered) value is the raw background color, so the W3C formula
    // collapses to a clean background pass-through.
    expect(wgsl).toContain('var blended = cb;');
  });
});


