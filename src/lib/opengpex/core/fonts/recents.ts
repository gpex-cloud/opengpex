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
 * Recently-used font tracking for the font picker.
 *
 * Persists an ordered list of most-recently-selected font families in
 * localStorage (most recent first, capped). Follows the same pure-helper
 * localStorage module pattern as local.ts and discovery.ts.
 */

const RECENT_FONTS_STORAGE_KEY = 'opengpex:recent-fonts';

/** Maximum number of recent families to remember */
export const MAX_RECENT_FONTS = 6;

/**
 * Get recently used font families, most recent first.
 */
export function getRecentFontFamilies(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(RECENT_FONTS_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Record a font selection as most-recently-used (deduped, capped).
 */
export function recordRecentFont(family: string, max: number = MAX_RECENT_FONTS): void {
  if (typeof window === 'undefined' || !family) return;
  try {
    const next = [family, ...getRecentFontFamilies().filter((f) => f !== family)].slice(0, max);
    localStorage.setItem(RECENT_FONTS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal: localStorage might be full or disabled
  }
}

/**
 * Clear recent-font history.
 */
export function clearRecentFonts(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(RECENT_FONTS_STORAGE_KEY);
  } catch {
    // Non-fatal
  }
}
