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
 * Web Font descriptor: Defines available web fonts and their loading metadata.
 */
export interface WebFont {
  /** Font family name (used by CSS font-family and document.fonts) */
  family: string;
  /** Display name for UI (may differ from family, e.g., localized names) */
  displayName?: string;
  /** Font category */
  category: 'sans-serif' | 'serif' | 'monospace' | 'display' | 'handwriting';
  /** Available weights */
  weights: number[];
  /** Whether italic variants are available */
  hasItalic: boolean;
  /** Google Fonts CSS URL (for initial download) */
  googleUrl?: string;
  /** Direct WOFF2 binary URL (alternative to Google Fonts, e.g., self-hosted CDN) */
  woff2Url?: string;
  /** Whether this font requires unicode-range subsetting (typically CJK fonts) */
  subsetted?: boolean;
  /** Preview text for font picker UI */
  preview?: string;
  /** Whether this is a system-bundled font (no download needed) */
  isSystem?: boolean;
}

/**
 * Helper: Generate Google Fonts CSS2 URL for a font family.
 * Supports optional italic and multiple weights.
 */
function gUrl(family: string, weights: number[], italic: boolean): string {
  const encoded = family.replace(/ /g, '+');
  if (italic) {
    const axes = weights
      .flatMap((w) => [`0,${w}`, `1,${w}`])
      .join(';');
    return `https://fonts.googleapis.com/css2?family=${encoded}:ital,wght@${axes}&display=swap`;
  }
  const wgts = weights.join(';');
  return `https://fonts.googleapis.com/css2?family=${encoded}:wght@${wgts}&display=swap`;
}

/**
 * Built-in font registry — curated selection of 60+ high-quality fonts.
 *
 * Design principles:
 * - System fonts are always available (no download needed)
 * - Google Fonts are on-demand (downloaded when user selects them)
 * - CJK fonts use unicode-range subsetting via Google Fonts CSS (browser downloads only needed glyphs)
 * - Curated for quality: covers Google Fonts Top 50 popularity + essential multi-language support
 */
export const FONT_REGISTRY: WebFont[] = [
  // ═══════════════════════════════════════════════════════════════════════
  // ─── System Fonts (always available, no download needed) ────────────
  // ═══════════════════════════════════════════════════════════════════════
  {
    family: 'Inter',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700],
    hasItalic: true,
    isSystem: true,
  },
  {
    family: 'Arial',
    category: 'sans-serif',
    weights: [400, 700],
    hasItalic: true,
    isSystem: true,
  },
  {
    family: 'Georgia',
    category: 'serif',
    weights: [400, 700],
    hasItalic: true,
    isSystem: true,
  },
  {
    family: 'Courier New',
    category: 'monospace',
    weights: [400, 700],
    hasItalic: true,
    isSystem: true,
  },
  {
    family: 'Times New Roman',
    category: 'serif',
    weights: [400, 700],
    hasItalic: true,
    isSystem: true,
  },
  {
    family: 'Verdana',
    category: 'sans-serif',
    weights: [400, 700],
    hasItalic: true,
    isSystem: true,
  },
  {
    family: 'Trebuchet MS',
    category: 'sans-serif',
    weights: [400, 700],
    hasItalic: true,
    isSystem: true,
  },
  {
    family: 'Impact',
    category: 'display',
    weights: [400],
    hasItalic: false,
    isSystem: true,
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ─── Sans-Serif (Google Fonts, on-demand download) ──────────────────
  // ═══════════════════════════════════════════════════════════════════════
  {
    family: 'Roboto',
    category: 'sans-serif',
    weights: [300, 400, 500, 700],
    hasItalic: true,
    googleUrl: gUrl('Roboto', [300, 400, 500, 700], true),
  },
  {
    family: 'Open Sans',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700, 800],
    hasItalic: true,
    googleUrl: gUrl('Open Sans', [300, 400, 500, 600, 700, 800], true),
  },
  {
    family: 'Lato',
    category: 'sans-serif',
    weights: [300, 400, 700, 900],
    hasItalic: true,
    googleUrl: gUrl('Lato', [300, 400, 700, 900], true),
  },
  {
    family: 'Montserrat',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700, 800, 900],
    hasItalic: true,
    googleUrl: gUrl('Montserrat', [300, 400, 500, 600, 700, 800, 900], true),
  },
  {
    family: 'Poppins',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700, 800],
    hasItalic: true,
    googleUrl: gUrl('Poppins', [300, 400, 500, 600, 700, 800], true),
  },
  {
    family: 'Nunito',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700, 800],
    hasItalic: true,
    googleUrl: gUrl('Nunito', [300, 400, 500, 600, 700, 800], true),
  },
  {
    family: 'Raleway',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700, 800],
    hasItalic: true,
    googleUrl: gUrl('Raleway', [300, 400, 500, 600, 700, 800], true),
  },
  {
    family: 'Ubuntu',
    category: 'sans-serif',
    weights: [300, 400, 500, 700],
    hasItalic: true,
    googleUrl: gUrl('Ubuntu', [300, 400, 500, 700], true),
  },
  {
    family: 'Outfit',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700],
    hasItalic: false,
    googleUrl: gUrl('Outfit', [300, 400, 500, 600, 700], false),
  },
  {
    family: 'Work Sans',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700],
    hasItalic: true,
    googleUrl: gUrl('Work Sans', [300, 400, 500, 600, 700], true),
  },
  {
    family: 'DM Sans',
    category: 'sans-serif',
    weights: [400, 500, 700],
    hasItalic: true,
    googleUrl: gUrl('DM Sans', [400, 500, 700], true),
  },
  {
    family: 'Quicksand',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700],
    hasItalic: false,
    googleUrl: gUrl('Quicksand', [300, 400, 500, 600, 700], false),
  },
  {
    family: 'Manrope',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700, 800],
    hasItalic: false,
    googleUrl: gUrl('Manrope', [300, 400, 500, 600, 700, 800], false),
  },
  {
    family: 'Space Grotesk',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700],
    hasItalic: false,
    googleUrl: gUrl('Space Grotesk', [300, 400, 500, 600, 700], false),
  },
  {
    family: 'Plus Jakarta Sans',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700, 800],
    hasItalic: true,
    googleUrl: gUrl('Plus Jakarta Sans', [300, 400, 500, 600, 700, 800], true),
  },
  {
    family: 'Fira Sans',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700],
    hasItalic: true,
    googleUrl: gUrl('Fira Sans', [300, 400, 500, 600, 700], true),
  },
  {
    family: 'Rubik',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700, 800],
    hasItalic: true,
    googleUrl: gUrl('Rubik', [300, 400, 500, 600, 700, 800], true),
  },
  {
    family: 'Karla',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700],
    hasItalic: true,
    googleUrl: gUrl('Karla', [300, 400, 500, 600, 700], true),
  },
  {
    family: 'Mulish',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700, 800],
    hasItalic: true,
    googleUrl: gUrl('Mulish', [300, 400, 500, 600, 700, 800], true),
  },
  {
    family: 'Jost',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700],
    hasItalic: true,
    googleUrl: gUrl('Jost', [300, 400, 500, 600, 700], true),
  },
  {
    family: 'Sora',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700, 800],
    hasItalic: false,
    googleUrl: gUrl('Sora', [300, 400, 500, 600, 700, 800], false),
  },
  {
    family: 'Albert Sans',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700, 800],
    hasItalic: true,
    googleUrl: gUrl('Albert Sans', [300, 400, 500, 600, 700, 800], true),
  },
  {
    family: 'Lexend',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700],
    hasItalic: false,
    googleUrl: gUrl('Lexend', [300, 400, 500, 600, 700], false),
  },
  {
    family: 'Figtree',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700, 800],
    hasItalic: true,
    googleUrl: gUrl('Figtree', [300, 400, 500, 600, 700, 800], true),
  },
  {
    family: 'Cabin',
    category: 'sans-serif',
    weights: [400, 500, 600, 700],
    hasItalic: true,
    googleUrl: gUrl('Cabin', [400, 500, 600, 700], true),
  },
  {
    family: 'Barlow',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700, 800],
    hasItalic: true,
    googleUrl: gUrl('Barlow', [300, 400, 500, 600, 700, 800], true),
  },
  {
    family: 'Josefin Sans',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700],
    hasItalic: true,
    googleUrl: gUrl('Josefin Sans', [300, 400, 500, 600, 700], true),
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ─── Serif (Google Fonts, on-demand download) ───────────────────────
  // ═══════════════════════════════════════════════════════════════════════
  {
    family: 'Playfair Display',
    category: 'serif',
    weights: [400, 500, 600, 700, 800, 900],
    hasItalic: true,
    googleUrl: gUrl('Playfair Display', [400, 500, 600, 700, 800, 900], true),
  },
  {
    family: 'Lora',
    category: 'serif',
    weights: [400, 500, 600, 700],
    hasItalic: true,
    googleUrl: gUrl('Lora', [400, 500, 600, 700], true),
  },
  {
    family: 'Merriweather',
    category: 'serif',
    weights: [300, 400, 700, 900],
    hasItalic: true,
    googleUrl: gUrl('Merriweather', [300, 400, 700, 900], true),
  },
  {
    family: 'Libre Baskerville',
    category: 'serif',
    weights: [400, 700],
    hasItalic: true,
    googleUrl: gUrl('Libre Baskerville', [400, 700], true),
  },
  {
    family: 'Source Serif 4',
    category: 'serif',
    weights: [300, 400, 500, 600, 700, 800],
    hasItalic: true,
    googleUrl: gUrl('Source Serif 4', [300, 400, 500, 600, 700, 800], true),
  },
  {
    family: 'Cormorant Garamond',
    category: 'serif',
    weights: [300, 400, 500, 600, 700],
    hasItalic: true,
    googleUrl: gUrl('Cormorant Garamond', [300, 400, 500, 600, 700], true),
  },
  {
    family: 'EB Garamond',
    category: 'serif',
    weights: [400, 500, 600, 700, 800],
    hasItalic: true,
    googleUrl: gUrl('EB Garamond', [400, 500, 600, 700, 800], true),
  },
  {
    family: 'Crimson Text',
    category: 'serif',
    weights: [400, 600, 700],
    hasItalic: true,
    googleUrl: gUrl('Crimson Text', [400, 600, 700], true),
  },
  {
    family: 'Spectral',
    category: 'serif',
    weights: [300, 400, 500, 600, 700, 800],
    hasItalic: true,
    googleUrl: gUrl('Spectral', [300, 400, 500, 600, 700, 800], true),
  },
  {
    family: 'Bitter',
    category: 'serif',
    weights: [300, 400, 500, 600, 700, 800],
    hasItalic: true,
    googleUrl: gUrl('Bitter', [300, 400, 500, 600, 700, 800], true),
  },
  {
    family: 'DM Serif Display',
    category: 'serif',
    weights: [400],
    hasItalic: true,
    googleUrl: gUrl('DM Serif Display', [400], true),
  },
  {
    family: 'Fraunces',
    category: 'serif',
    weights: [300, 400, 500, 600, 700, 800, 900],
    hasItalic: true,
    googleUrl: gUrl('Fraunces', [300, 400, 500, 600, 700, 800, 900], true),
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ─── Monospace (Google Fonts, on-demand download) ───────────────────
  // ═══════════════════════════════════════════════════════════════════════
  {
    family: 'JetBrains Mono',
    category: 'monospace',
    weights: [400, 500, 600, 700],
    hasItalic: true,
    googleUrl: gUrl('JetBrains Mono', [400, 500, 600, 700], true),
  },
  {
    family: 'Fira Code',
    category: 'monospace',
    weights: [300, 400, 500, 600, 700],
    hasItalic: false,
    googleUrl: gUrl('Fira Code', [300, 400, 500, 600, 700], false),
  },
  {
    family: 'Source Code Pro',
    category: 'monospace',
    weights: [300, 400, 500, 600, 700],
    hasItalic: true,
    googleUrl: gUrl('Source Code Pro', [300, 400, 500, 600, 700], true),
  },
  {
    family: 'IBM Plex Mono',
    category: 'monospace',
    weights: [300, 400, 500, 600, 700],
    hasItalic: true,
    googleUrl: gUrl('IBM Plex Mono', [300, 400, 500, 600, 700], true),
  },
  {
    family: 'Space Mono',
    category: 'monospace',
    weights: [400, 700],
    hasItalic: true,
    googleUrl: gUrl('Space Mono', [400, 700], true),
  },
  {
    family: 'Inconsolata',
    category: 'monospace',
    weights: [300, 400, 500, 600, 700, 800],
    hasItalic: false,
    googleUrl: gUrl('Inconsolata', [300, 400, 500, 600, 700, 800], false),
  },
  {
    family: 'Roboto Mono',
    category: 'monospace',
    weights: [300, 400, 500, 600, 700],
    hasItalic: true,
    googleUrl: gUrl('Roboto Mono', [300, 400, 500, 600, 700], true),
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ─── Display & Handwriting (Google Fonts, on-demand download) ───────
  // ═══════════════════════════════════════════════════════════════════════
  {
    family: 'Pacifico',
    category: 'handwriting',
    weights: [400],
    hasItalic: false,
    googleUrl: gUrl('Pacifico', [400], false),
  },
  {
    family: 'Dancing Script',
    category: 'handwriting',
    weights: [400, 500, 600, 700],
    hasItalic: false,
    googleUrl: gUrl('Dancing Script', [400, 500, 600, 700], false),
  },
  {
    family: 'Caveat',
    category: 'handwriting',
    weights: [400, 500, 600, 700],
    hasItalic: false,
    googleUrl: gUrl('Caveat', [400, 500, 600, 700], false),
  },
  {
    family: 'Lobster',
    category: 'display',
    weights: [400],
    hasItalic: false,
    googleUrl: gUrl('Lobster', [400], false),
  },
  {
    family: 'Permanent Marker',
    category: 'handwriting',
    weights: [400],
    hasItalic: false,
    googleUrl: gUrl('Permanent Marker', [400], false),
  },
  {
    family: 'Satisfy',
    category: 'handwriting',
    weights: [400],
    hasItalic: false,
    googleUrl: gUrl('Satisfy', [400], false),
  },
  {
    family: 'Indie Flower',
    category: 'handwriting',
    weights: [400],
    hasItalic: false,
    googleUrl: gUrl('Indie Flower', [400], false),
  },
  {
    family: 'Comfortaa',
    category: 'display',
    weights: [300, 400, 500, 600, 700],
    hasItalic: false,
    googleUrl: gUrl('Comfortaa', [300, 400, 500, 600, 700], false),
  },
  {
    family: 'Righteous',
    category: 'display',
    weights: [400],
    hasItalic: false,
    googleUrl: gUrl('Righteous', [400], false),
  },
  {
    family: 'Abril Fatface',
    category: 'display',
    weights: [400],
    hasItalic: false,
    googleUrl: gUrl('Abril Fatface', [400], false),
  },
  {
    family: 'Fredoka',
    category: 'display',
    weights: [300, 400, 500, 600, 700],
    hasItalic: false,
    googleUrl: gUrl('Fredoka', [300, 400, 500, 600, 700], false),
  },
  {
    family: 'Bebas Neue',
    category: 'display',
    weights: [400],
    hasItalic: false,
    googleUrl: gUrl('Bebas Neue', [400], false),
  },
  {
    family: 'Titan One',
    category: 'display',
    weights: [400],
    hasItalic: false,
    googleUrl: gUrl('Titan One', [400], false),
  },
  {
    family: 'Bungee',
    category: 'display',
    weights: [400],
    hasItalic: false,
    googleUrl: gUrl('Bungee', [400], false),
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ─── CJK Fonts (subsetted, on-demand via unicode-range) ────────────
  // ═══════════════════════════════════════════════════════════════════════
  {
    family: 'Noto Sans SC',
    displayName: '思源黑体',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700],
    hasItalic: false,
    subsetted: true,
    googleUrl: gUrl('Noto Sans SC', [300, 400, 500, 600, 700], false),
    preview: '永远相信美好的事情即将发生',
  },
  {
    family: 'Noto Serif SC',
    displayName: '思源宋体',
    category: 'serif',
    weights: [300, 400, 500, 600, 700],
    hasItalic: false,
    subsetted: true,
    googleUrl: gUrl('Noto Serif SC', [300, 400, 500, 600, 700], false),
    preview: '春风得意马蹄疾',
  },
  {
    family: 'Noto Sans TC',
    displayName: '思源黑體',
    category: 'sans-serif',
    weights: [300, 400, 500, 700],
    hasItalic: false,
    subsetted: true,
    googleUrl: gUrl('Noto Sans TC', [300, 400, 500, 700], false),
    preview: '永遠相信美好的事情即將發生',
  },
  {
    family: 'Noto Serif TC',
    displayName: '思源宋體',
    category: 'serif',
    weights: [300, 400, 500, 600, 700],
    hasItalic: false,
    subsetted: true,
    googleUrl: gUrl('Noto Serif TC', [300, 400, 500, 600, 700], false),
    preview: '春風得意馬蹄疾',
  },
  {
    family: 'Noto Sans JP',
    displayName: 'Noto Sans JP',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700],
    hasItalic: false,
    subsetted: true,
    googleUrl: gUrl('Noto Sans JP', [300, 400, 500, 600, 700], false),
    preview: 'こんにちは世界',
  },
  {
    family: 'Noto Serif JP',
    displayName: 'Noto Serif JP',
    category: 'serif',
    weights: [300, 400, 500, 600, 700],
    hasItalic: false,
    subsetted: true,
    googleUrl: gUrl('Noto Serif JP', [300, 400, 500, 600, 700], false),
    preview: 'こんにちは世界',
  },
  {
    family: 'Noto Sans KR',
    displayName: 'Noto Sans KR',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700],
    hasItalic: false,
    subsetted: true,
    googleUrl: gUrl('Noto Sans KR', [300, 400, 500, 600, 700], false),
    preview: '안녕하세요 세계',
  },
  {
    family: 'Noto Serif KR',
    displayName: 'Noto Serif KR',
    category: 'serif',
    weights: [300, 400, 500, 600, 700],
    hasItalic: false,
    subsetted: true,
    googleUrl: gUrl('Noto Serif KR', [300, 400, 500, 600, 700], false),
    preview: '안녕하세요 세계',
  },
];
