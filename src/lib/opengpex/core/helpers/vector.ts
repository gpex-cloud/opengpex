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
 * helpers/vector.ts: Lightweight main-thread vector format intrinsic size parser.
 *
 * Supports SVG and EPS. Reads only the first few KB of the file header
 * to extract dimensions without any WASM or Worker dependency.
 *
 * SVG: parses width/height attributes and viewBox via DOMParser.
 * EPS: parses %%BoundingBox comment (PostScript DSC convention).
 */

/**
 * Gets the intrinsic (natural) size of a vector file in points (1pt = 1/72 inch).
 * For SVG: returns the CSS pixel size (effectively points at 72dpi baseline).
 * For EPS: returns the BoundingBox size in PostScript points.
 *
 * @param file - The vector file (SVG or EPS)
 * @returns Intrinsic size in points {w, h}
 */
export async function getVectorIntrinsicSize(file: File): Promise<{ w: number; h: number }> {
  const format = detectVectorFormat(file);

  // Read only the first 8KB — sufficient for all header metadata
  const headerSlice = file.slice(0, 8192);
  const headerText = await headerSlice.text();

  if (format === 'svg') {
    return parseSvgSize(headerText);
  }
  if (format === 'eps') {
    return parseEpsBoundingBox(headerText);
  }

  throw new Error(`[vector] Unsupported vector format: ${file.type || file.name}`);
}

/**
 * Detects vector format from MIME type or file extension.
 */
export function detectVectorFormat(file: File): 'svg' | 'eps' | null {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();

  if (type === 'image/svg+xml' || name.endsWith('.svg')) return 'svg';
  if (
    type === 'application/postscript' ||
    type === 'application/eps' ||
    type === 'image/x-eps' ||
    name.endsWith('.eps') ||
    name.endsWith('.epsf')
  ) return 'eps';

  return null;
}

/**
 * Parses SVG intrinsic size from the header text.
 * Strategy:
 * 1. Try width/height attributes (may have units like px, pt, cm, in, mm)
 * 2. Fallback to viewBox attribute
 * 3. Default to 300×150 (SVG spec default)
 */
function parseSvgSize(headerText: string): { w: number; h: number } {
  // Use DOMParser for robust XML attribute extraction
  // Wrap in try-catch for malformed SVG fallback to regex
  try {
    const doc = new DOMParser().parseFromString(headerText, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (svg) {
      const widthAttr = svg.getAttribute('width');
      const heightAttr = svg.getAttribute('height');
      const viewBox = svg.getAttribute('viewBox');

      // If explicit width/height exist, parse them
      if (widthAttr && heightAttr) {
        const w = parseSvgLength(widthAttr);
        const h = parseSvgLength(heightAttr);
        if (w > 0 && h > 0) return { w, h };
      }

      // Fallback to viewBox
      if (viewBox) {
        const parts = viewBox.trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
          return { w: parts[2], h: parts[3] };
        }
      }

      // If only width/height as percentages + viewBox, use viewBox
      if (viewBox) {
        const parts = viewBox.trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4) return { w: parts[2], h: parts[3] };
      }
    }
  } catch {
    // DOMParser failed, try regex fallback
  }

  // Regex fallback for malformed SVG or partial header
  return parseSvgSizeRegex(headerText);
}

/**
 * Regex fallback for SVG size extraction.
 */
function parseSvgSizeRegex(text: string): { w: number; h: number } {
  // Try viewBox first (most reliable)
  const vbMatch = text.match(/viewBox\s*=\s*["']([^"']+)["']/i);
  if (vbMatch) {
    const parts = vbMatch[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { w: parts[2], h: parts[3] };
    }
  }

  // Try width/height attributes
  const wMatch = text.match(/\bwidth\s*=\s*["']([^"']+)["']/i);
  const hMatch = text.match(/\bheight\s*=\s*["']([^"']+)["']/i);
  if (wMatch && hMatch) {
    const w = parseSvgLength(wMatch[1]);
    const h = parseSvgLength(hMatch[1]);
    if (w > 0 && h > 0) return { w, h };
  }

  // SVG spec default
  return { w: 300, h: 150 };
}

/**
 * Parses an SVG length value with optional units to pixels (points at 72dpi).
 * Supported units: px, pt, in, cm, mm, em, ex, (none = px)
 * Reference: 1in = 96px (CSS), 1in = 72pt, 1cm = 37.8px, 1mm = 3.78px
 *
 * We normalize to "user units" which for our purposes = CSS px = 1pt at 72dpi.
 */
function parseSvgLength(value: string): number {
  const trimmed = value.trim();
  const numMatch = trimmed.match(/^([0-9]*\.?[0-9]+)\s*(px|pt|in|cm|mm|em|ex|%)?$/i);
  if (!numMatch) return 0;

  const num = parseFloat(numMatch[1]);
  const unit = (numMatch[2] || 'px').toLowerCase();

  switch (unit) {
    case 'px': return num;
    case 'pt': return num * (96 / 72); // 1pt = 96/72 px in CSS
    case 'in': return num * 96;
    case 'cm': return num * (96 / 2.54);
    case 'mm': return num * (96 / 25.4);
    case 'em': return num * 16; // Assume 16px default font-size
    case 'ex': return num * 8;  // Assume ~8px x-height
    case '%': return 0; // Percentage requires container — cannot resolve standalone
    default: return num;
  }
}

/**
 * Parses EPS intrinsic size from %%BoundingBox DSC comment.
 * Format: %%BoundingBox: llx lly urx ury (in PostScript points, 1pt = 1/72 inch)
 *
 * @returns Size in PostScript points {w, h}
 */
function parseEpsBoundingBox(headerText: string): { w: number; h: number } {
  // Try high-res bounding box first (more precise)
  const hiresBBMatch = headerText.match(/%%HiResBoundingBox:\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (hiresBBMatch) {
    const [, llx, lly, urx, ury] = hiresBBMatch.map(Number);
    const w = urx - llx;
    const h = ury - lly;
    if (w > 0 && h > 0) return { w, h };
  }

  // Standard BoundingBox (integer points)
  const bbMatch = headerText.match(/%%BoundingBox:\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
  if (bbMatch) {
    const [, llx, lly, urx, ury] = bbMatch.map(Number);
    const w = urx - llx;
    const h = ury - lly;
    if (w > 0 && h > 0) return { w, h };
  }

  throw new Error('[vector] EPS file missing %%BoundingBox comment');
}
