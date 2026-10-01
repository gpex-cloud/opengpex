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

import React, { useRef } from 'react';
import { useEditorState } from '@opengpex/editor/core/context';
import {
  useBrushOverlayState,
  useBrushToolLifecycle,
  useBrushCursorTracking,
  useBrushParams,
  useBrushColor,
} from './hooks';

// ─── BrushOverlayMain ─────────────────────────────────────────────────────────

/**
 * BrushOverlayMain: STAGE_OVERLAY surface for the vector brush.
 *
 * It renders ONE thing: the brush cursor ring. There is deliberately no stroke
 * preview element — the in-progress stroke is a genuine scene layer composited
 * by the render pipeline (see interactions.ts).
 */
export const BrushOverlayMain = React.memo(function BrushOverlayMain() {
  const { isBrushMode } = useBrushOverlayState();

  useBrushToolLifecycle(isBrushMode);

  if (!isBrushMode) return null;
  return <BrushCursor />;
});

// ─── BrushCursor ──────────────────────────────────────────────────────────────

/**
 * BrushCursor: the size-accurate brush ring that replaces the native cursor.
 *
 * Diameter = `brushSize × camera.k`, so the ring covers exactly the pixels the
 * stroke will paint at the current zoom. Position follows the pointer at 60fps
 * and the diameter follows the camera through the volatile ticker — both by
 * direct style writes, never by a React re-render (see hooks/useFastSync).
 *
 * The child order here is a contract with `useBrushCursorFastSync`:
 * [0] outer ring, [1] inner ring, [2] colour fill.
 */
const BrushCursor = React.memo(function BrushCursor() {
  const cursorRef = useRef<HTMLDivElement>(null);
  const { brushSize } = useBrushParams();
  const brushColor = useBrushColor();
  const { activeFrame } = useEditorState();

  useBrushCursorTracking(cursorRef, true, brushSize);

  const cameraK = activeFrame?.camera.k || 1;
  const screenDiameter = Math.max(brushSize * cameraK, 4); // keep it visible when tiny
  const halfSize = screenDiameter / 2;

  return (
    <div
      ref={cursorRef}
      className="absolute top-0 left-0 pointer-events-none"
      style={{
        opacity: 0, // revealed on the first pointermove
        willChange: 'transform',
        zIndex: 9999,
        marginLeft: `-${halfSize}px`,
        marginTop: `-${halfSize}px`,
      }}
    >
      {/* [0] Outer ring: white, readable on dark artwork */}
      <div
        className="absolute rounded-full"
        style={{
          width: `${screenDiameter}px`,
          height: `${screenDiameter}px`,
          border: '1px solid rgba(255, 255, 255, 0.8)',
          boxSizing: 'border-box',
        }}
      />

      {/* [1] Inner ring: black, readable on light artwork */}
      <div
        className="absolute rounded-full"
        style={{
          width: `${screenDiameter - 2}px`,
          height: `${screenDiameter - 2}px`,
          left: '1px',
          top: '1px',
          border: '1px solid rgba(0, 0, 0, 0.5)',
          boxSizing: 'border-box',
        }}
      />

      {/* [2] Colour fill preview (hidden when the ring is too small to read) */}
      {screenDiameter > 6 && (
        <div
          className="absolute rounded-full"
          style={{
            width: `${screenDiameter - 4}px`,
            height: `${screenDiameter - 4}px`,
            left: '2px',
            top: '2px',
            backgroundColor: brushColor,
            opacity: 0.1,
          }}
        />
      )}

      {/* Centre crosshair: the exact sample point fed into the trajectory */}
      <div
        data-cross="v"
        className="absolute"
        style={{
          width: '1px',
          height: '6px',
          left: `${halfSize - 0.5}px`,
          top: `${halfSize - 3}px`,
          backgroundColor: 'rgba(255, 255, 255, 0.9)',
          boxShadow: '0 0 1px rgba(0, 0, 0, 0.8)',
        }}
      />
      <div
        data-cross="h"
        className="absolute"
        style={{
          width: '6px',
          height: '1px',
          left: `${halfSize - 3}px`,
          top: `${halfSize - 0.5}px`,
          backgroundColor: 'rgba(255, 255, 255, 0.9)',
          boxShadow: '0 0 1px rgba(0, 0, 0, 0.8)',
        }}
      />
    </div>
  );
});
