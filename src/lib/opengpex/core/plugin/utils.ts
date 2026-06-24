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
 * shortcut-formatter.ts
 * Core Responsibility: Maps machine-readable shortcut definitions to human-readable display strings.
 * OS adaptive: displays ⌘/⇧ symbols on Mac and Ctrl/Shift text on Windows.
 */

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

export interface Modifiers {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  /**
   * Number of consecutive taps required, default 1. When >1 the formatted
   * label gets prefixed with `Nx ` (e.g. `2x A`) so tooltips and the
   * shortcut panel surface the multi-tap requirement to users.
   */
  taps?: number;
}

export function formatShortcut(key: string, mods: Modifiers): string {

  const parts: string[] = [];

  if (isMac) {
    if (mods.ctrl) parts.push('⌃');
    if (mods.alt) parts.push('⌥');
    if (mods.shift) parts.push('⇧');
    if (mods.meta) parts.push('⌘');
  } else {
    if (mods.ctrl) parts.push('Ctrl');
    if (mods.meta) parts.push('Win');
    if (mods.alt) parts.push('Alt');
    if (mods.shift) parts.push('Shift');
  }

  // Map special function keys to symbols or standard labels
  const getLabel = (k: string) => {
    const lowerKey = k.toLowerCase();

    // Mac style symbols
    if (isMac) {
      if (lowerKey === 'backspace') return '⌫';
      if (lowerKey === 'delete') return 'DEL'; // Display DEL even on Mac to enhance Windows user recognition
      if (lowerKey === 'enter') return '↩';
      if (lowerKey === 'escape') return '⎋';
      if (lowerKey === 'arrowup') return '↑';
      if (lowerKey === 'arrowdown') return '↓';
      if (lowerKey === 'arrowleft') return '←';
      if (lowerKey === 'arrowright') return '→';
    }

    // Generic/Win style labels
    if (lowerKey === ' ') return 'Space';
    if (lowerKey === 'backspace') return 'BACKSPACE';
    if (lowerKey === 'delete') return 'DEL';
    if (lowerKey === 'enter') return 'ENTER';

    return k.toUpperCase();
  };

  parts.push(getLabel(key));

  const base = parts.join(isMac ? '' : ' + ');
  // Multi-tap prefix: render `2x A`, `3x A`, etc. so the multi-tap
  // requirement is visible everywhere the label appears (tooltips,
  // shortcut panel). Single-tap (default) falls through unchanged so no
  // existing label is altered.
  const taps = mods.taps ?? 1;
  return taps > 1 ? `${taps}x ${base}` : base;
}


