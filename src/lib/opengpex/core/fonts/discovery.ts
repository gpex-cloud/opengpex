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

import type { WebFont } from './registry';

/**
 * Google Fonts API response types (simplified)
 */
interface GoogleFontItem {
  family: string;
  variants: string[];
  category: string;
}

interface GoogleFontsResponse {
  items: GoogleFontItem[];
}

/**
 * Local storage key for persisted user font picks (fonts from discovery that user has selected)
 */
const USER_FONTS_STORAGE_KEY = 'opengpex:user-discovered-fonts';

/**
 * In-memory cache of the full Google Fonts directory (fetched once per session)
 */
let googleFontsCache: GoogleFontItem[] | null = null;
let fetchPromise: Promise<GoogleFontItem[]> | null = null;

/**
 * Parse Google Fonts variants into weights array and hasItalic flag.
 */
function parseVariants(variants: string[]): { weights: number[]; hasItalic: boolean } {
  const weights = new Set<number>();
  let hasItalic = false;

  for (const v of variants) {
    if (v === 'regular') {
      weights.add(400);
    } else if (v === 'italic') {
      weights.add(400);
      hasItalic = true;
    } else if (v.endsWith('italic')) {
      const w = parseInt(v.replace('italic', ''), 10);
      if (!isNaN(w)) weights.add(w);
      hasItalic = true;
    } else {
      const w = parseInt(v, 10);
      if (!isNaN(w)) weights.add(w);
    }
  }

  // Ensure at least weight 400
  if (weights.size === 0) weights.add(400);

  return {
    weights: Array.from(weights).sort((a, b) => a - b),
    hasItalic,
  };
}

/**
 * Map a Google Fonts category string to our WebFont category type.
 */
function mapCategory(cat: string): WebFont['category'] {
  switch (cat) {
    case 'sans-serif': return 'sans-serif';
    case 'serif': return 'serif';
    case 'monospace': return 'monospace';
    case 'display': return 'display';
    case 'handwriting': return 'handwriting';
    default: return 'sans-serif';
  }
}

/**
 * Convert a GoogleFontItem to a WebFont descriptor.
 */
function toWebFont(item: GoogleFontItem): WebFont {
  const { weights, hasItalic } = parseVariants(item.variants);
  const encoded = item.family.replace(/ /g, '+');

  let googleUrl: string;
  if (hasItalic) {
    const axes = weights
      .flatMap((w) => [`0,${w}`, `1,${w}`])
      .join(';');
    googleUrl = `https://fonts.googleapis.com/css2?family=${encoded}:ital,wght@${axes}&display=swap`;
  } else {
    const wgts = weights.join(';');
    googleUrl = `https://fonts.googleapis.com/css2?family=${encoded}:wght@${wgts}&display=swap`;
  }

  return {
    family: item.family,
    category: mapCategory(item.category),
    weights,
    hasItalic,
    googleUrl,
  };
}

/**
 * Fetch the full Google Fonts directory (cached in memory for the session).
 * Uses the public Google Fonts Developer API (no key required for the CSS endpoint,
 * but we use the metadata endpoint which is also publicly accessible).
 *
 * Fallback: If the API is unavailable, returns an empty array.
 */
async function fetchGoogleFontsDirectory(): Promise<GoogleFontItem[]> {
  if (googleFontsCache) return googleFontsCache;
  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    try {
      // Use the Google Fonts API without key — limited but functional for font metadata
      // Alternative: Use the webfonts API endpoint that doesn't require a key
      const res = await fetch(
        'https://www.googleapis.com/webfonts/v1/webfonts?sort=popularity&key=AIzaSyBwIX97bVWr3-6AIUvGkcNnmFgirefZ-Sw',
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: GoogleFontsResponse = await res.json();
      googleFontsCache = data.items || [];
      return googleFontsCache;
    } catch (e) {
      console.warn('[FontDiscovery] Failed to fetch Google Fonts directory:', e);
      return [];
    } finally {
      fetchPromise = null;
    }
  })();

  return fetchPromise;
}

/**
 * Search Google Fonts by query string.
 * Returns up to `limit` matching WebFont descriptors not already in the provided registry.
 *
 * @param query - Search string (matched against font family name)
 * @param existingFamilies - Set of font families already in the local registry (to exclude from results)
 * @param limit - Maximum number of results to return (default: 20)
 */
export async function searchGoogleFonts(
  query: string,
  existingFamilies: Set<string>,
  limit = 20,
): Promise<WebFont[]> {
  if (!query.trim()) return [];

  const directory = await fetchGoogleFontsDirectory();
  if (!directory.length) return [];

  const q = query.toLowerCase();
  const matches: WebFont[] = [];

  for (const item of directory) {
    if (matches.length >= limit) break;
    if (existingFamilies.has(item.family)) continue;
    if (item.family.toLowerCase().includes(q)) {
      matches.push(toWebFont(item));
    }
  }

  return matches;
}

/**
 * Get user-discovered fonts from localStorage.
 * These are fonts the user previously selected from Google Fonts search results
 * that are not in the built-in FONT_REGISTRY.
 */
export function getUserDiscoveredFonts(): WebFont[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(USER_FONTS_STORAGE_KEY);
    if (!stored) return [];
    return JSON.parse(stored) as WebFont[];
  } catch {
    return [];
  }
}

/**
 * Persist a discovered font to localStorage so it appears in the user's font list
 * on subsequent visits.
 */
export function saveUserDiscoveredFont(font: WebFont): void {
  if (typeof window === 'undefined') return;
  try {
    const existing = getUserDiscoveredFonts();
    // Avoid duplicates
    if (existing.some((f) => f.family === font.family)) return;
    existing.push(font);
    localStorage.setItem(USER_FONTS_STORAGE_KEY, JSON.stringify(existing));
  } catch {
    // Non-fatal: localStorage might be full or disabled
  }
}

/**
 * Remove a discovered font from localStorage.
 */
export function removeUserDiscoveredFont(family: string): void {
  if (typeof window === 'undefined') return;
  try {
    const existing = getUserDiscoveredFonts().filter((f) => f.family !== family);
    localStorage.setItem(USER_FONTS_STORAGE_KEY, JSON.stringify(existing));
  } catch {
    // Non-fatal
  }
}
