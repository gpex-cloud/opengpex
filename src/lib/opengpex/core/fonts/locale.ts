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

import { WebFont } from './registry';

/**
 * Gets the user's browser locale hint (e.g. "zh-CN", "ja", "en-US")
 */
export function getUserLocaleHint(): string {
  if (typeof navigator === 'undefined') return 'en';
  return navigator.language || (navigator.languages && navigator.languages[0]) || 'en';
}

/**
 * Returns a recommended, locale-aware sorted font list for the font picker UI.
 *
 * Behavior:
 * - Chinese users (zh-*): CJK SC/TC fonts promoted to the top
 * - Japanese users (ja): JP fonts promoted to the top
 * - Korean users (ko): KR fonts promoted to the top
 * - Other locales: CJK fonts sorted to the bottom (available under "More Languages" group)
 *
 * Note: This only affects UI display order. It does NOT restrict which fonts users can access.
 */
export function getRecommendedFonts(registry: WebFont[], locale?: string): WebFont[] {
  const effectiveLocale = locale || getUserLocaleHint();
  const sorted = [...registry];

  if (effectiveLocale.startsWith('zh')) {
    // Chinese users: Noto Sans SC, Noto Serif SC, etc. promoted to top
    sorted.sort((a, b) => {
      const aIsCJK = a.family.includes('SC') || a.family.includes('TC');
      const bIsCJK = b.family.includes('SC') || b.family.includes('TC');
      if (aIsCJK && !bIsCJK) return -1;
      if (!aIsCJK && bIsCJK) return 1;
      return 0;
    });
  } else if (effectiveLocale.startsWith('ja')) {
    // Japanese users: JP fonts promoted to top
    sorted.sort((a, b) => {
      const aIsJP = a.family.includes('JP');
      const bIsJP = b.family.includes('JP');
      if (aIsJP && !bIsJP) return -1;
      if (!aIsJP && bIsJP) return 1;
      return 0;
    });
  } else if (effectiveLocale.startsWith('ko')) {
    // Korean users: KR fonts promoted to top
    sorted.sort((a, b) => {
      const aIsKR = a.family.includes('KR');
      const bIsKR = b.family.includes('KR');
      if (aIsKR && !bIsKR) return -1;
      if (!aIsKR && bIsKR) return 1;
      return 0;
    });
  } else {
    // Other users: CJK fonts deprioritized (placed in "More Languages" group)
    sorted.sort((a, b) => {
      const aIsCJK = !!a.subsetted;
      const bIsCJK = !!b.subsetted;
      if (aIsCJK && !bIsCJK) return 1;
      if (!aIsCJK && bIsCJK) return -1;
      return 0;
    });
  }

  return sorted;
}

/**
 * Splits fonts into primary and secondary groups based on locale.
 * Primary: Fonts recommended for the user's locale
 * Secondary: Fonts in the "More Languages" category (CJK for non-CJK users, etc.)
 */
export function splitFontsByLocale(registry: WebFont[], locale?: string): {
  primary: WebFont[];
  secondary: WebFont[];
} {
  const effectiveLocale = locale || getUserLocaleHint();
  const isCJKUser = effectiveLocale.startsWith('zh') || effectiveLocale.startsWith('ja') || effectiveLocale.startsWith('ko');

  if (isCJKUser) {
    // CJK users see all fonts in primary list
    return { primary: registry, secondary: [] };
  }

  // Non-CJK users: separate CJK fonts into secondary group
  const primary: WebFont[] = [];
  const secondary: WebFont[] = [];

  for (const font of registry) {
    if (font.subsetted) {
      secondary.push(font);
    } else {
      primary.push(font);
    }
  }

  return { primary, secondary };
}
