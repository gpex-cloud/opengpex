/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the GNU General Public License.
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
 * EfxIcon: the Effects drawer's custom glyph — the letters "Efx" drawn as
 * lucide-idiom strokes (24×24 viewBox, currentColor, 2px, round caps).
 *
 * Typographic composition (baseline-aligned, like a typeset wordmark):
 *
 *   ┐              x-height letters "fx" sit on the SAME baseline as the
 *   ├─────  fx     cap-height "E", but only reach x-height — the size step
 *   ┘              makes three letters legible inside a 24px box.
 *
 *   E : x 4.5–10,  cap height y 4.5–19.5 (full height)
 *   f : x 12–17,   ascender to y 9.5, x-height body 12.5–19.5
 *   x : x 18–22,   x-height y 13.5–19.5
 *
 * All three share the baseline y = 19.5; the descending size step (cap →
 * ascender → x-height) reads naturally left-to-right, echoing the "fx"
 * layer-style idiom while keeping the E for "Effects".
 */

/** The "E": stem plus three bars, cap height. */
function EGlyph() {
  return (
    <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M4.5 4.5 V19.5" />
      <path d="M4.5 4.5 H10" />
      <path d="M4.5 12 H8.8" />
      <path d="M4.5 19.5 H10" />
    </g>
  );
}

/** The "f": ascender with a top hook, crossbar at x-height. */
function FGlyph() {
  return (
    <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M14.5 19.5 V12.5 C14.5 10.6 15.4 9.5 17 9.5" />
      <path d="M12.3 14 H16.7" />
    </g>
  );
}

/** The "x": two crossing strokes, x-height. */
function XGlyph() {
  return (
    <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M18.2 13.5 L21.8 19.5" />
      <path d="M21.8 13.5 L18.2 19.5" />
    </g>
  );
}

export function EfxIcon({ size = 20, className }: { size?: number; className?: string } = {}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <EGlyph />
      <FGlyph />
      <XGlyph />
    </svg>
  );
}
