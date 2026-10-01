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
 * srgbHsv.ts — THE SINGLE SOURCE OF TRUTH for sRGB HSV/HSL/hex scalar math.
 *
 * These utilities used to live inline in `widgets/ColorPickerPro.tsx`. They were
 * sunk here so the palette widget and the structured-colour model
 * ({@link ColorValue}) share ONE implementation instead of each carrying a copy —
 * `ColorPickerPro` now re-exports the six 8-bit helpers from this module.
 *
 * PRECISION: {@link hsvToRgbF} is the primitive — it returns UNQUANTIZED floats in
 * [0,1]. {@link hsvToRgb} is the historical 8-bit view (`round(·*255)`), kept
 * byte-identical to the old ColorPickerPro function so nothing downstream shifts.
 * `srgbFromHsv` ({@link ColorValue}) builds on the float primitive so wide-gamut /
 * Pro f32 SV-Hue never collapses to 256 levels.
 *
 * @module core/engine/color/srgbHsv
 */

/** RGB channel triple. Units are stated per function (0–1 float vs 0–255 int). */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * HSV → RGB as UNQUANTIZED floats in [0,1] (the precision-preserving primitive).
 *
 * @param h - hue, normalized [0,1)
 * @param s - saturation [0,1]
 * @param v - value/brightness [0,1]
 */
export function hsvToRgbF(h: number, s: number, v: number): Rgb {
  let r = 0,
    g = 0,
    b = 0;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0:
      r = v;
      g = t;
      b = p;
      break;
    case 1:
      r = q;
      g = v;
      b = p;
      break;
    case 2:
      r = p;
      g = v;
      b = t;
      break;
    case 3:
      r = p;
      g = q;
      b = v;
      break;
    case 4:
      r = t;
      g = p;
      b = v;
      break;
    case 5:
      r = v;
      g = p;
      b = q;
      break;
  }
  return { r, g, b };
}

/**
 * HSV → RGB as 8-bit integers (0–255). Byte-identical to the historical
 * `ColorPickerPro.hsvToRgb`; a thin `round(·*255)` view over {@link hsvToRgbF}.
 */
export function hsvToRgb(h: number, s: number, v: number): Rgb {
  const f = hsvToRgbF(h, s, v);
  return {
    r: Math.round(f.r * 255),
    g: Math.round(f.g * 255),
    b: Math.round(f.b * 255),
  };
}

/**
 * RGB (8-bit 0–255) → HSV. Hue normalized [0,1), s/v in [0,1].
 */
export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const v = max;
  const d = max - min;
  s = max === 0 ? 0 : d / max;
  if (max === min) {
    h = 0;
  } else {
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return { h, s, v };
}

/**
 * RGB (8-bit 0–255) → HSL. Hue in [0,360], s/l as integer percents [0,100].
 */
export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }
  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

/**
 * HSL (h 0–360, s/l percent 0–100) → RGB 8-bit integers (0–255).
 */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  h /= 360;
  s /= 100;
  l /= 100;
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

/** RGB 8-bit integers (0–255) → `"#rrggbb"` (lowercase). */
export function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((x) => {
        const hex = x.toString(16);
        return hex.length === 1 ? "0" + hex : hex;
      })
      .join("")
  );
}

/**
 * `"#rgb"` / `"#rrggbb"` → RGB 8-bit integers (0–255), or `null` when the string
 * is not a 3- or 6-digit hex triple.
 */
export function hexToRgb(hex: string): Rgb | null {
  let c = hex.replace("#", "");
  if (c.length === 3)
    c = c
      .split("")
      .map((x) => x + x)
      .join("");
  if (c.length !== 6) return null;
  const num = parseInt(c, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
