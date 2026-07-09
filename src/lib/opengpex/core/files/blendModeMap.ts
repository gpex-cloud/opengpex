/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Blend Mode Mapping: Canvas2D globalCompositeOperation → Composite Engine BlendMode
 *
 * Used by the 16-bit multi-layer composite export to translate layer blend modes
 * from the Canvas2D rendering domain to the compositing engine domain.
 *
 * References:
 * - Canvas2D: https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/globalCompositeOperation
 * - libvips blend modes: https://www.libvips.org/API/current/libvips-conversion.html#VipsBlendMode
 */

/**
 * Maps Canvas2D globalCompositeOperation values to composite blend mode strings.
 *
 * Not all Canvas2D modes have direct equivalents — fallback to 'over' for unsupported ones.
 */
export const BLEND_MODE_MAP: Record<string, string> = {
  // ─── Normal / Porter-Duff ─────────────────────────────────────────────────
  'source-over': 'over',           // Default: layer paints over background
  'source-atop': 'atop',
  'source-in': 'in',
  'source-out': 'out',
  'destination-over': 'dest-over',
  'destination-atop': 'dest-atop',
  'destination-in': 'dest-in',
  'destination-out': 'dest-out',
  'xor': 'xor',
  'copy': 'over',                  // Canvas 'copy' = replace; closest vips = 'over'
  'lighter': 'add',               // Canvas 'lighter' = additive blend

  // ─── Compositing Blend Modes ──────────────────────────────────────────────
  'multiply': 'multiply',
  'screen': 'screen',
  'overlay': 'overlay',
  'darken': 'darken',
  'lighten': 'lighten',
  'color-dodge': 'colour-dodge',
  'color-burn': 'colour-burn',
  'hard-light': 'hard-light',
  'soft-light': 'soft-light',
  'difference': 'difference',
  'exclusion': 'exclusion',

  // ─── HSL Blend Modes ──────────────────────────────────────────────────────
  'hue': 'over',                   // vips doesn't have direct HSL blend; fallback to 'over'
  'saturation': 'saturate',
  'color': 'over',                 // No direct vips equivalent
  'luminosity': 'over',            // No direct vips equivalent
};

/**
 * Map a Canvas2D blend mode to the corresponding composite blend mode string.
 * Falls back to 'over' (normal) for unrecognized modes.
 */
export function mapBlendMode(canvasBlendMode: string | undefined): string {
  if (!canvasBlendMode) return 'over';
  return BLEND_MODE_MAP[canvasBlendMode] || 'over';
}
