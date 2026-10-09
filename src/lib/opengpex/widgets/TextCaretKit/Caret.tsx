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
import { useCaretAnchor, type UseCaretAnchorOptions } from './useCaretAnchor';

export interface TextCaretProps extends UseCaretAnchorOptions {
  /**
   * CSS custom property holding the counter-scale (1 / current camera scale)
   * that keeps the caret bar screen-constant. The HOST must set this variable
   * on the caret's offset parent and keep it updated when the camera moves.
   */
  scaleVarName?: string;
  /** Caret bar width in screen px before counter-scaling (default 1.2). */
  widthPx?: number;
}

const DEFAULT_SCALE_VAR = '--text-caret-scale';

/**
 * TextCaret: precision custom caret replacement for contenteditable.
 *
 * Solves two core readability and ergonomic problems of the native browser caret:
 * 1. Height: Native caret spans the full `fontSize × lineHeight` box (often 1.4-1.8x),
 *    which looks awkwardly tall and penetrates line boundaries. Custom caret clamps
 *    height to glyph cap-height (~0.86x fontSize) and centers vertically within the line.
 * 2. Width & Zoom Invariance: Native caret is 1px and stretches / blurs when parent CSS
 *    matrix zooms. The caret bar counter-scales via the host-provided CSS variable
 *    (default `--text-caret-scale`) to stay a crisp, screen-constant bar at any zoom.
 *
 * Pure render shell: all measurement lives in geometry.ts, all tracking in
 * useCaretAnchor. Position is container-local, so camera pan/zoom moves the
 * caret for free along with the host container.
 */
export const TextCaret = React.memo(function TextCaret({
  scaleVarName = DEFAULT_SCALE_VAR,
  widthPx = 1.2,
  ...anchorOptions
}: TextCaretProps) {
  const { anchor, actionKey } = useCaretAnchor(anchorOptions);

  if (!anchor) return null;

  return (
    <>
      <style>{`
        @keyframes text-custom-caret-blink {
          0%, 45% { opacity: 1; }
          50%, 95% { opacity: 0; }
          100% { opacity: 1; }
        }
      `}</style>
      <div
        key={actionKey}
        className="pointer-events-none"
        style={{
          position: 'absolute',
          left: `${anchor.localX}px`,
          top: `${anchor.localY}px`,
          width: `calc(${widthPx}px * var(${scaleVarName}, 1))`,
          height: `${anchor.height}px`,
          backgroundColor: '#ffffff',
          boxShadow: `0 0 0 calc(0.65px * var(${scaleVarName}, 1)) #000000`,
          borderRadius: '0.5px',
          animation: 'text-custom-caret-blink 1s cubic-bezier(0.4, 0, 0.6, 1) infinite',
          zIndex: 10,
        }}
      />
    </>
  );
});
