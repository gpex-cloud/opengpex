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
 * Local Font Access API wrapper.
 *
 * The Local Font Access API (Chrome 103+, Edge 103+) allows web applications
 * to enumerate fonts installed on the user's device — similar to what desktop
 * applications like Photoshop and Word do.
 *
 * This module provides:
 * - Feature detection (isLocalFontAccessSupported)
 * - Permission-aware font scanning (queryLocalFonts)
 * - Deduplication and mapping to WebFont descriptors
 * - Persistence of discovered local fonts via localStorage
 *
 * Browser support:
 * - ✅ Chrome/Edge 103+
 * - ❌ Firefox (not supported)
 * - ❌ Safari (not supported)
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Local_Font_Access_API
 */

import type { WebFont } from './registry';

// ─── Types ──────────────────────────────────────────────────────────────────────

/**
 * The browser's FontData interface (from Local Font Access API)
 */
interface FontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
}

/**
 * Result of a local font scan operation
 */
export interface LocalFontScanResult {
  /** Whether the scan was successful */
  success: boolean;
  /** Number of unique font families found */
  familyCount: number;
  /** The discovered fonts mapped to WebFont descriptors */
  fonts: WebFont[];
  /** Error message if scan failed */
  error?: string;
}

// ─── LocalStorage persistence ───────────────────────────────────────────────────

const LOCAL_FONTS_STORAGE_KEY = 'opengpex:local-fonts';

/**
 * Get persisted local fonts from localStorage.
 */
export function getPersistedLocalFonts(): WebFont[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(LOCAL_FONTS_STORAGE_KEY);
    if (!stored) return [];
    return JSON.parse(stored) as WebFont[];
  } catch {
    return [];
  }
}

/**
 * Persist local fonts to localStorage.
 */
function persistLocalFonts(fonts: WebFont[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(LOCAL_FONTS_STORAGE_KEY, JSON.stringify(fonts));
  } catch {
    // Non-fatal: localStorage might be full
  }
}

/**
 * Clear persisted local fonts from localStorage.
 */
export function clearPersistedLocalFonts(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(LOCAL_FONTS_STORAGE_KEY);
  } catch {
    // Non-fatal
  }
}

// ─── Feature Detection ──────────────────────────────────────────────────────────

/**
 * Check if the Local Font Access API is available in the current browser.
 *
 * @returns true if `window.queryLocalFonts` is available (Chrome/Edge 103+)
 */
export function isLocalFontAccessSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return 'queryLocalFonts' in window && typeof (window as unknown as { queryLocalFonts: unknown }).queryLocalFonts === 'function';
}

// ─── Font Scanning ──────────────────────────────────────────────────────────────

/**
 * Infer a category from the font family name (heuristic-based).
 */
function inferCategory(family: string): WebFont['category'] {
  const lower = family.toLowerCase();
  if (lower.includes('mono') || lower.includes('code') || lower.includes('console') || lower.includes('courier')) {
    return 'monospace';
  }
  if (lower.includes('serif') && !lower.includes('sans')) {
    return 'serif';
  }
  if (lower.includes('script') || lower.includes('hand') || lower.includes('cursive')) {
    return 'handwriting';
  }
  if (lower.includes('display') || lower.includes('decorat')) {
    return 'display';
  }
  return 'sans-serif';
}

/**
 * Parse font style string to determine weight.
 */
function parseWeight(style: string): number {
  const lower = style.toLowerCase();
  if (lower.includes('thin') || lower.includes('hairline')) return 100;
  if (lower.includes('extralight') || lower.includes('ultra light')) return 200;
  if (lower.includes('light')) return 300;
  if (lower.includes('medium')) return 500;
  if (lower.includes('semibold') || lower.includes('demi bold')) return 600;
  if (lower.includes('extrabold') || lower.includes('ultra bold')) return 800;
  if (lower.includes('bold') || lower.includes('heavy')) return 700;
  if (lower.includes('black')) return 900;
  return 400;
}

/**
 * Check if a font style represents italic.
 */
function isItalicStyle(style: string): boolean {
  const lower = style.toLowerCase();
  return lower.includes('italic') || lower.includes('oblique');
}

/**
 * Query local fonts using the Local Font Access API.
 *
 * This will trigger a browser permission prompt on first use.
 * The user must grant "local-fonts" permission for this to work.
 *
 * @param existingFamilies - Set of font families already in the registry (to report overlap)
 * @returns LocalFontScanResult with discovered fonts
 */
export async function queryLocalFonts(existingFamilies: Set<string>): Promise<LocalFontScanResult> {
  if (!isLocalFontAccessSupported()) {
    return {
      success: false,
      familyCount: 0,
      fonts: [],
      error: 'Local Font Access API is not supported in this browser. Chrome/Edge 103+ required.',
    };
  }

  try {
    // Call the browser API (triggers permission prompt)
    const fontDataArray: FontData[] = await (window as unknown as { queryLocalFonts: () => Promise<FontData[]> }).queryLocalFonts();

    // Group by family to deduplicate variants
    const familyMap = new Map<string, { weights: Set<number>; hasItalic: boolean }>();

    for (const fontData of fontDataArray) {
      const family = fontData.family;
      if (!familyMap.has(family)) {
        familyMap.set(family, { weights: new Set(), hasItalic: false });
      }
      const entry = familyMap.get(family)!;
      entry.weights.add(parseWeight(fontData.style));
      if (isItalicStyle(fontData.style)) {
        entry.hasItalic = true;
      }
    }

    // Convert to WebFont descriptors (only fonts NOT already in registry)
    const localFonts: WebFont[] = [];

    for (const [family, data] of familyMap) {
      if (existingFamilies.has(family)) continue; // Skip fonts already in built-in registry

      localFonts.push({
        family,
        category: inferCategory(family),
        weights: Array.from(data.weights).sort((a, b) => a - b),
        hasItalic: data.hasItalic,
        isSystem: true, // Local fonts are system-installed, no download needed
      });
    }

    // Sort alphabetically
    localFonts.sort((a, b) => a.family.localeCompare(b.family));

    // Persist to localStorage
    persistLocalFonts(localFonts);

    return {
      success: true,
      familyCount: localFonts.length,
      fonts: localFonts,
    };
  } catch (e: unknown) {
    const errorMessage = e instanceof Error ? e.message : 'Unknown error';

    // Handle specific error cases
    if (errorMessage.includes('permission') || errorMessage.includes('denied')) {
      return {
        success: false,
        familyCount: 0,
        fonts: [],
        error: 'Permission denied. Please allow access to local fonts when prompted.',
      };
    }

    return {
      success: false,
      familyCount: 0,
      fonts: [],
      error: `Failed to scan local fonts: ${errorMessage}`,
    };
  }
}
