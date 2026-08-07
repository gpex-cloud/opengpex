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
 * DPI / Resolution utilities for OpenGPEX.
 *
 * DPI (Dots Per Inch) connects pixel dimensions to physical print size:
 *   physicalSize (inches) = pixels / dpi
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Constants & Presets
// ═══════════════════════════════════════════════════════════════════════════════

export const DEFAULT_DPI = 72;
export const MIN_DPI = 1;
export const MAX_DPI = 9999;

export const DPI_PRESETS = [
  { value: 72,   label: 'Screen (macOS)',      category: 'screen' },
  { value: 96,   label: 'Screen (Windows)',    category: 'screen' },
  { value: 144,  label: 'Retina 2x',          category: 'screen' },
  { value: 150,  label: 'Draft Print',         category: 'print'  },
  { value: 200,  label: 'Newspaper / Poster',  category: 'print'  },
  { value: 300,  label: 'Standard Print',      category: 'print'  },
  { value: 600,  label: 'High-quality Print',  category: 'print'  },
  { value: 1200, label: 'Fine Art / Scan',     category: 'print'  },
] as const;

// ═══════════════════════════════════════════════════════════════════════════════
// Calculation Utilities
// ═══════════════════════════════════════════════════════════════════════════════

/** Pixels → physical size in inches */
export function pxToInches(px: number, dpi: number): number {
  return px / (dpi || DEFAULT_DPI);
}

/** Pixels → physical size in centimeters */
export function pxToCm(px: number, dpi: number): number {
  return pxToInches(px, dpi) * 2.54;
}

/** Physical size (inches) → pixels */
export function inchesToPx(inches: number, dpi: number): number {
  return Math.round(inches * dpi);
}

/** Physical size (cm) → pixels */
export function cmToPx(cm: number, dpi: number): number {
  return Math.round((cm / 2.54) * dpi);
}

/** Format print size for display */
export function formatPrintSize(w: number, h: number, dpi: number): string {
  const wIn = pxToInches(w, dpi);
  const hIn = pxToInches(h, dpi);
  const wCm = wIn * 2.54;
  const hCm = hIn * 2.54;
  return `${wIn.toFixed(2)} × ${hIn.toFixed(2)} in (${wCm.toFixed(1)} × ${hCm.toFixed(1)} cm)`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sanitize a raw DPI value to ensure it's a valid integer within acceptable range.
 * Returns DEFAULT_DPI (72) for any invalid / out-of-range input.
 */
export function sanitizeDpi(raw: number | undefined | null): number {
  if (!raw || raw <= 0 || raw > MAX_DPI || !isFinite(raw)) return DEFAULT_DPI;
  // Some tools incorrectly write 1 as resolution — treat as missing
  if (raw < 2) return DEFAULT_DPI;
  return Math.round(raw);
}

