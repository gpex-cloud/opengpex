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

'use client';

import React from 'react';
import { useSelectionRects, type UseSelectionRectsOptions } from './useSelectionRects';

export interface TextSelectionProps extends UseSelectionRectsOptions {
  /**
   * Background color of selection highlights.
   * Defaults to modern semi-transparent accent blue (`rgba(59, 130, 246, 0.35)`).
   */
  color?: string;
  /** Border radius of highlight boxes in local px (default 2). */
  borderRadius?: number;
}

/**
 * TextSelection: precision custom selection highlight replacement for contenteditable.
 *
 * Replaces the native browser `::selection` background, which notoriously suffers
 * from font metric overflows (e.g. CJK fonts spanning 1.4-1.5em and crossing line boundaries).
 * Renders neatly clamped, vertically centered selection boxes under the text glyphs.
 */
export const TextSelection = React.memo(function TextSelection({
  color = 'rgba(59, 130, 246, 0.35)',
  borderRadius = 0,
  ...options
}: TextSelectionProps) {
  const rects = useSelectionRects(options);

  if (rects.length === 0) return null;

  return (
    <div
      data-text-selection-layer
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 1 }}
    >
      {rects.map((rect, idx) => (
        <div
          key={idx}
          style={{
            position: 'absolute',
            left: `${rect.localX}px`,
            top: `${rect.localY}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            backgroundColor: color,
            borderRadius: `${borderRadius}px`,
            pointerEvents: 'none',
          }}
        />
      ))}
    </div>
  );
});
