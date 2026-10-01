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
import { useMosaicOverlayState, useMosaicCursorTracking, useMosaicParams } from './hooks';
import { useStrokePreviewFastSync } from './useFastSync';

// ─── MosaicOverlayMain ─────────────────────────────────────────────────────────

/**
 * MosaicOverlayMain: Mosaic overlay main component
 *
 * Render in STAGE_OVERLAY layer:
 * - MosaicCursor: Circular cursor with checkerboard badge (follows mouse, 60fps DOM manipulation)
 * - StrokePreview: Real-time stroke preview canvas
 */
export const MosaicOverlayMain = React.memo(function MosaicOverlayMain() {
  const { isMosaicMode } = useMosaicOverlayState();

  if (!isMosaicMode) return null;

  return (
    <>
      <MosaicCursor />
      <StrokePreview />
    </>
  );
});

// ─── MosaicCursor ──────────────────────────────────────────────────────────────

/**
 * MosaicCursor: Double-layer circular cursor for mosaic tool
 *
 * Follows the mouse at 60fps via useMosaicCursorTracking (zero React redraw).
 */
const MosaicCursor = React.memo(function MosaicCursor() {
  const cursorRef = useRef<HTMLDivElement>(null);
  const { brushDiameter } = useMosaicParams();
  const { activeFrame } = useEditorState();

  useMosaicCursorTracking(cursorRef, true, brushDiameter);

  const cameraK = activeFrame?.camera.k || 1;
  const screenDiameter = Math.max(brushDiameter * cameraK, 4);
  const halfSize = screenDiameter / 2;

  return (
    <div
      ref={cursorRef}
      className="absolute top-0 left-0 pointer-events-none"
      style={{
        opacity: 0,
        willChange: 'transform',
        zIndex: 9999,
        marginLeft: `-${halfSize}px`,
        marginTop: `-${halfSize}px`,
      }}
    >
      {/* Outer ring: white solid stroke */}
      <div
        className="absolute rounded-full"
        style={{
          width: `${screenDiameter}px`,
          height: `${screenDiameter}px`,
          border: '1px solid rgba(255, 255, 255, 0.8)',
          boxSizing: 'border-box',
        }}
      />

      {/* Inner ring: black solid stroke */}
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

      {/* Center crosshair */}
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

      {/* Tool identity badge (bottom-right): 2×2 checkerboard icon (mosaic) */}
      <svg
        data-badge="tool-id"
        className="absolute pointer-events-none"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        style={{
          left: `${Math.max(screenDiameter - 1, halfSize + 2)}px`,
          top: `${Math.max(screenDiameter - 1, halfSize + 2)}px`,
          filter: 'drop-shadow(0 0.5px 1px rgba(0,0,0,0.9))',
        }}
      >
        <rect x="3" y="3" width="9" height="9" rx="1" fill="white" />
        <rect x="12" y="12" width="9" height="9" rx="1" fill="white" />
        <rect x="3" y="3" width="18" height="18" rx="2" stroke="white" strokeWidth="2.5" fill="none" />
        <line x1="12" y1="3" x2="12" y2="21" stroke="white" strokeWidth="2" />
        <line x1="3" y1="12" x2="21" y2="12" stroke="white" strokeWidth="2" />
      </svg>

      {/* Force-new-layer badge: "+" shown while Cmd/Ctrl is held */}
      <div
        data-badge="new-layer"
        className="absolute"
        style={{
          opacity: 0,
          left: `${Math.max(screenDiameter - 1, halfSize + 2) + 17}px`,
          top: `${Math.max(screenDiameter - 1, halfSize + 2) + 1}px`,
          width: '12px',
          height: '12px',
          borderRadius: '50%',
          backgroundColor: 'var(--accent, #6366f1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '11px',
          fontWeight: 900,
          color: '#fff',
          lineHeight: 1,
          boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
        }}
      >
        +
      </div>
    </div>
  );
});

// ─── StrokePreview ─────────────────────────────────────────────────────────────

/**
 * StrokePreview: Real-time stroke preview
 */
const StrokePreview = React.memo(function StrokePreview() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { activeFrame } = useEditorState();

  const canvasW = activeFrame?.camera ? activeFrame.canvas.w : 0;
  const canvasH = activeFrame?.camera ? activeFrame.canvas.h : 0;

  useStrokePreviewFastSync(containerRef, canvasRef);

  if (!activeFrame || !canvasW || !canvasH) return null;

  return (
    <div
      ref={containerRef}
      className="absolute top-0 left-0 pointer-events-none"
      style={{
        transformOrigin: '0 0',
        willChange: 'transform',
      }}
    >
      <canvas
        ref={canvasRef}
        width={canvasW}
        height={canvasH}
        className="block"
        style={{
          width: `${canvasW}px`,
          height: `${canvasH}px`,
          imageRendering: 'pixelated',
        }}
      />
    </div>
  );
});
