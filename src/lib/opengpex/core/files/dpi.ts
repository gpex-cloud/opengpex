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

// ═══════════════════════════════════════════════════════════════════════════════
// PNG pHYs Chunk Injection
// ═══════════════════════════════════════════════════════════════════════════════

/** CRC32 lookup table (PNG standard polynomial) */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

/** Compute CRC32 over a Uint8Array slice */
function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Inject a pHYs chunk into a PNG Blob to encode physical pixel density (DPI).
 *
 * PNG pHYs chunk format (13 bytes data):
 *   - 4 bytes: pixels per unit, X axis (big-endian uint32)
 *   - 4 bytes: pixels per unit, Y axis (big-endian uint32)
 *   - 1 byte:  unit specifier (1 = meter)
 *
 * Conversion: pixels/meter = DPI / 0.0254
 *   e.g. 300 DPI → 11811 pixels/meter
 */
export async function injectPngDpi(blob: Blob, dpi: number): Promise<Blob> {
  if (dpi <= 0) return blob;

  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Verify PNG signature (8 bytes)
  const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) return blob; // Not a PNG, return as-is
  }

  // Calculate pixels per meter
  const ppm = Math.round(dpi / 0.0254);

  // Build pHYs chunk: 4(length) + 4(type) + 13(data) + 4(CRC) = 25 bytes
  const phys = new Uint8Array(25);
  const view = new DataView(phys.buffer);

  // Length = 13
  view.setUint32(0, 13, false);
  // Type = "pHYs" (0x70 0x48 0x59 0x73)
  phys[4] = 0x70; phys[5] = 0x48; phys[6] = 0x59; phys[7] = 0x73;
  // X pixels per unit
  view.setUint32(8, ppm, false);
  // Y pixels per unit
  view.setUint32(12, ppm, false);
  // Unit: meter (1)
  phys[16] = 1;
  // CRC over type + data (bytes 4..16, inclusive = 13 bytes)
  const crcVal = crc32(phys.slice(4, 17));
  view.setUint32(17, crcVal, false);

  // Insert position: immediately after IHDR chunk
  // PNG structure: 8(sig) + 4(IHDR length=13) + 4(IHDR type) + 13(IHDR data) + 4(IHDR CRC) = 33
  const insertPos = 33;

  // Assemble: [PNG header + IHDR] + [pHYs] + [rest of chunks]
  const result = new Uint8Array(bytes.length + phys.length);
  result.set(bytes.slice(0, insertPos), 0);
  result.set(phys, insertPos);
  result.set(bytes.slice(insertPos), insertPos + phys.length);

  return new Blob([result], { type: 'image/png' });
}
