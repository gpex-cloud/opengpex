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
 * cursors.ts — The pen tool's cursor set (Photoshop's pen cursor grammar).
 *
 * Every pen cursor shares the crosshair + nib body of the base tool cursor
 * (the same read as the pen selection slot) and differs only by a small
 * BADGE glyph at the top-right, so the pointer itself announces what the
 * next press will do before the user commits to it:
 *
 *   (none)  continue the open subpath with the next anchor
 *   *       start a NEW subpath (nothing receptive is open)
 *   o       close the open subpath onto its first anchor
 *   /       resume a frozen open subpath from its end anchor
 *   +       insert an anchor on the hovered segment (shape preserved)
 *   -       delete the hovered anchor
 *   ^       convert: Alt over an anchor/handle (smooth ⇄ corner, break
 *           symmetry) or the just-placed anchor (click retracts its
 *           outgoing handle so the next segment leaves straight)
 *
 * The direct-selection arrow (hollow "white arrow") marks a control handle
 * hover: pressing drags that handle, never places a point.
 *
 * All glyphs are drawn twice (white halo under black line) so they stay
 * legible over any image. Hotspot = crosshair center (8,8); the arrow's is
 * its tip. Values are complete CSS `cursor` strings with a keyword fallback.
 */

import type { PenHoverIntent } from './hoverIntent';

const SVG_OPEN = `%3Csvg xmlns='http://www.w3.org/2000/svg' width='26' height='24' fill='none'%3E`;
const SVG_CLOSE = `%3C/svg%3E`;

const CROSSHAIR = `%3Cpath d='M8 1v5M8 11v5M1 8h5M11 8h5' stroke='white' stroke-width='2' stroke-linecap='round'/%3E`
  + `%3Cpath d='M8 1v5M8 11v5M1 8h5M11 8h5' stroke='black' stroke-width='1' stroke-linecap='round'/%3E`;

const NIB = `%3Cpath d='M14 21l2.5-7.5L21 9l1.5 1.5-4.5 4.5L14 21z' stroke='white' stroke-width='2.5' stroke-linejoin='round' fill='none'/%3E`
  + `%3Cpath d='M14 21l2.5-7.5L21 9l1.5 1.5-4.5 4.5L14 21z' stroke='black' stroke-width='1' stroke-linejoin='round' fill='none'/%3E`;

/** Halo + line pair for one badge path (top-right corner, ~6px box). */
const badge = (d: string): string =>
  `%3Cpath d='${d}' stroke='white' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E`
  + `%3Cpath d='${d}' stroke='black' stroke-width='1' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E`;

const penCursor = (badgeSvg: string): string =>
  `url("data:image/svg+xml,${SVG_OPEN}${CROSSHAIR}${NIB}${badgeSvg}${SVG_CLOSE}") 8 8, crosshair`;

/** Badge glyph paths, centered around (20.5, 4.5). */
const GLYPH_NEW_PATH = 'M20.5 1.5v6M17.9 3l5.2 3M23.1 3l-5.2 3';
const GLYPH_CLOSE = 'M18 4.5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0';
const GLYPH_RESUME = 'M18 7.5l5-6';
const GLYPH_ADD = 'M20.5 1.5v6M17.5 4.5h6';
const GLYPH_REMOVE = 'M17.5 4.5h6';
const GLYPH_CONVERT = 'M17.5 7l3-5l3 5';

/** The base pen cursor (crosshair + nib, no badge): continue the open subpath. */
export const PEN_CURSOR_BASE = penCursor('');
export const PEN_CURSOR_NEW_PATH = penCursor(badge(GLYPH_NEW_PATH));
export const PEN_CURSOR_CLOSE = penCursor(badge(GLYPH_CLOSE));
export const PEN_CURSOR_RESUME = penCursor(badge(GLYPH_RESUME));
export const PEN_CURSOR_ADD_POINT = penCursor(badge(GLYPH_ADD));
export const PEN_CURSOR_REMOVE_POINT = penCursor(badge(GLYPH_REMOVE));
export const PEN_CURSOR_CONVERT = penCursor(badge(GLYPH_CONVERT));

/**
 * Direct-selection arrow (hollow): a control handle is under the pointer and
 * a press drags it. Hotspot at the arrow tip.
 */
export const PEN_CURSOR_DIRECT_SELECT = `url("data:image/svg+xml,${SVG_OPEN}`
  + `%3Cpath d='M3 2l0 15l4-3.5l3 7l3-1.3l-3-6.8l5.5 0z' fill='white' stroke='black' stroke-width='1' stroke-linejoin='round'/%3E`
  + `${SVG_CLOSE}") 3 2, default`;

/**
 * Hover intent → cursor. `continue` maps to null: the registered tool base
 * cursor (crosshair + nib) shows through the cursor service's priority
 * chain, so an idle pointer never fights a stale hover declaration.
 */
export const PEN_INTENT_CURSORS: Record<PenHoverIntent, string | null> = {
  'continue': null,
  'new-path': PEN_CURSOR_NEW_PATH,
  'close': PEN_CURSOR_CLOSE,
  'resume': PEN_CURSOR_RESUME,
  'add-point': PEN_CURSOR_ADD_POINT,
  'remove-point': PEN_CURSOR_REMOVE_POINT,
  'convert': PEN_CURSOR_CONVERT,
  'direct-select': PEN_CURSOR_DIRECT_SELECT,
};
