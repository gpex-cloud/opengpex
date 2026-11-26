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
 * blendMath.ts — The 16-mode pure color blend math as a SHAREABLE WGSL
 * snippet.
 *
 * Both consumers need the EXACT same formulas:
 *   • BlendPass (blend.ts) — the W3C ping-pong layer blend.
 *   • Color Overlay effect (effectOverlayCompose.ts) — the per-layer surface
 *     effect that mixes its solid colour into the content RGB by one of the
 *     same 16 modes.
 *
 * CONTRACT: every function here operates on UN-PREMULTIPLIED working-LINEAR
 * RGB (the Rec.709 linear-light domain blend.ts documents). `apply_blend`
 * is the single entry: mode index 0..15 matching `BLEND_MODE_MAP`, backdrop
 * first, foreground second — identical argument order and behaviour to the
 * code that used to live inline in BLEND_WGSL, so BlendPass output is
 * byte-identical after the extraction.
 *
 * INCLUDE SAFETY: this snippet declares NO uniforms, NO bindings and NO
 * entry points (@compute / @vertex / @fragment) — only pure functions — so
 * it can be concatenated ahead of any consumer's glue without redeclaration
 * or entry-point collisions. Consumer glues must be concatenated AFTER it.
 *
 * @module core/gpu/shaders/blendMath
 */

export const BLEND_MATH_WGSL = /* wgsl */ `
// ────────────────────────────────────────────────────────────
// Non-separable HSL Blend Math Functions
// ────────────────────────────────────────────────────────────

// Luminosity coefficients — Rec.709.
//
// ⚠️ DELIBERATELY NOT the W3C 0.3/0.59/0.11. Those coefficients are defined for
// ENCODED (gamma) values; v2 blends in LINEAR LIGHT, where the
// physically-correct luminance weights are Rec.709 (0.2126/0.7152/0.0722) — the
// same weights adjust.wgsl's ADJ_LUMA already uses. This is a domain-consistent
// pairing, not a free choice: using gamma-domain coefficients on linear values
// would mis-weight every hue/saturation/color/luminosity blend.
fn lum(c : vec3<f32>) -> f32 {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

fn clip_color(c_in : vec3<f32>) -> vec3<f32> {
  var c = c_in;
  let l = lum(c);
  let n = min(min(c.r, c.g), c.b);
  let x = max(max(c.r, c.g), c.b);

  if (n < 0.0) {
    let denom = select(1.0, l - n, (l - n) != 0.0);
    c = l + (((c - l) * l) / denom);
  }
  if (x > 1.0) {
    let denom = select(1.0, x - l, (x - l) != 0.0);
    c = l + (((c - l) * (1.0 - l)) / denom);
  }
  return clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn set_lum(c : vec3<f32>, l : f32) -> vec3<f32> {
  let d = l - lum(c);
  return clip_color(c + vec3<f32>(d));
}

fn sat(c : vec3<f32>) -> f32 {
  return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
}

fn set_sat(c : vec3<f32>, s : f32) -> vec3<f32> {
  let curr_sat = sat(c);
  if (curr_sat <= 0.00001) {
    return vec3<f32>(0.0);
  }

  let r = c.r;
  let g = c.g;
  let b = c.b;

  var res = vec3<f32>(0.0);
  if (r <= g && g <= b) {
    res.r = 0.0;
    res.g = ((g - r) * s) / curr_sat;
    res.b = s;
  } else if (r <= b && b <= g) {
    res.r = 0.0;
    res.b = ((b - r) * s) / curr_sat;
    res.g = s;
  } else if (g <= r && r <= b) {
    res.g = 0.0;
    res.r = ((r - g) * s) / curr_sat;
    res.b = s;
  } else if (g <= b && b <= r) {
    res.g = 0.0;
    res.b = ((b - g) * s) / curr_sat;
    res.r = s;
  } else if (b <= r && r <= g) {
    res.b = 0.0;
    res.r = ((r - b) * s) / curr_sat;
    res.g = s;
  } else {
    res.b = 0.0;
    res.g = ((g - b) * s) / curr_sat;
    res.r = s;
  }
  return res;
}

fn blend_hue(bg : vec3<f32>, fg : vec3<f32>) -> vec3<f32> {
  return set_lum(set_sat(fg, sat(bg)), lum(bg));
}

fn blend_saturation(bg : vec3<f32>, fg : vec3<f32>) -> vec3<f32> {
  return set_lum(set_sat(bg, sat(fg)), lum(bg));
}

fn blend_color(bg : vec3<f32>, fg : vec3<f32>) -> vec3<f32> {
  return set_lum(fg, lum(bg));
}

fn blend_luminosity(bg : vec3<f32>, fg : vec3<f32>) -> vec3<f32> {
  return set_lum(bg, lum(fg));
}

// ────────────────────────────────────────────────────────────
// Per-channel Component Helpers
// ────────────────────────────────────────────────────────────

fn overlay_ch(b : f32, f : f32) -> f32 {
  if (b < 0.5) {
    return 2.0 * b * f;
  }
  return 1.0 - 2.0 * (1.0 - b) * (1.0 - f);
}

fn soft_light_ch(b : f32, f : f32) -> f32 {
  if (f <= 0.5) {
    return b - (1.0 - 2.0 * f) * b * (1.0 - b);
  }
  let d = select(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, b <= 0.25);
  return b + (2.0 * f - 1.0) * (d - b);
}

fn color_dodge_ch(b : f32, f : f32) -> f32 {
  if (b <= 0.0) { return 0.0; }
  if (f >= 1.0) { return 1.0; }
  return min(1.0, b / (1.0 - f));
}

fn color_burn_ch(b : f32, f : f32) -> f32 {
  if (b >= 1.0) { return 1.0; }
  if (f <= 0.0) { return 0.0; }
  return 1.0 - min(1.0, (1.0 - b) / f);
}

// ────────────────────────────────────────────────────────────
// Pure Color Blend Function (16 Modes)
// ────────────────────────────────────────────────────────────

fn apply_blend(bg : vec3<f32>, fg : vec3<f32>, mode : u32) -> vec3<f32> {
  // ── BOUNDED FAMILY operand clamp (formula-family strategy) ──
  // The bounded modes (overlay / color-dodge / color-burn / hard-light /
  // soft-light + the four HSL modes) are authored on [0,1] operands (W3C), so
  // their FOREGROUND operand is clamped here in STRAIGHT space — never the
  // premultiplied value (clamping premultiplied RGB would hue-shift every
  // semi-transparent HDR edge). The BACKDROP flows through unclamped:
  // overlay/hard-light/soft-light extend polynomially and keep tracking HDR
  // backdrop light; the dodge/burn guards and clip_color impose their own
  // intrinsic W3C bounds. The total formulas (multiply / screen / darken /
  // lighten / difference / exclusion / source-over) are total over ≥ 0 and
  // pass through untouched. For [0,1] SDR content the clamp is a no-op —
  // bit-identical to the pre-HDR behaviour.
  let bounded = (mode >= 3u && mode <= 9u && mode != 4u && mode != 5u) || mode >= 12u;
  let fg_op = select(fg, clamp(fg, vec3<f32>(0.0), vec3<f32>(1.0)), bounded);

  switch (mode) {
    case 0u: { // Normal / source-over
      return fg;
    }
    case 1u: { // Multiply
      return bg * fg;
    }
    case 2u: { // Screen
      return 1.0 - (1.0 - bg) * (1.0 - fg);
    }
    case 3u: { // Overlay
      return vec3<f32>(
        overlay_ch(bg.r, fg_op.r),
        overlay_ch(bg.g, fg_op.g),
        overlay_ch(bg.b, fg_op.b)
      );
    }
    case 4u: { // Darken
      return min(bg, fg);
    }
    case 5u: { // Lighten
      return max(bg, fg);
    }
    case 6u: { // Color Dodge
      return vec3<f32>(
        color_dodge_ch(bg.r, fg_op.r),
        color_dodge_ch(bg.g, fg_op.g),
        color_dodge_ch(bg.b, fg_op.b)
      );
    }
    case 7u: { // Color Burn
      return vec3<f32>(
        color_burn_ch(bg.r, fg_op.r),
        color_burn_ch(bg.g, fg_op.g),
        color_burn_ch(bg.b, fg_op.b)
      );
    }
    case 8u: { // Hard Light
      return vec3<f32>(
        overlay_ch(fg_op.r, bg.r),
        overlay_ch(fg_op.g, bg.g),
        overlay_ch(fg_op.b, bg.b)
      );
    }
    case 9u: { // Soft Light
      return vec3<f32>(
        soft_light_ch(bg.r, fg_op.r),
        soft_light_ch(bg.g, fg_op.g),
        soft_light_ch(bg.b, fg_op.b)
      );
    }
    case 10u: { // Difference
      return abs(bg - fg);
    }
    case 11u: { // Exclusion
      return bg + fg - 2.0 * bg * fg;
    }
    case 12u: { // Hue
      return blend_hue(bg, fg_op);
    }
    case 13u: { // Saturation
      return blend_saturation(bg, fg_op);
    }
    case 14u: { // Color
      return blend_color(bg, fg_op);
    }
    case 15u: { // Luminosity
      return blend_luminosity(bg, fg_op);
    }
    default: {
      return fg;
    }
  }
}
`;
