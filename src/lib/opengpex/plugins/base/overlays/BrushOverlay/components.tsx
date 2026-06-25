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
import { useFastSync } from '@opengpex/editor/core/motion/hooks/navigation';
import { VolatileState, Frame, CameraState } from '@opengpex/editor/core/types';
import { useBrushOverlayState, useBrushCursorTracking, useBrushParams, useBrushColor } from './hooks';
import { getStrokeBuffer, getStrokeVersion } from './interactions';

// ─── BrushOverlayMain ──────────────────────────────────────────────────────────

/**
 * BrushOverlayMain: Brush overlay main component
 *
 * Render in STAGE_OVERLAY layer:
 * - BrushCursor: Double-layer circular cursor (follows mouse, 60fps DOM manipulation)
 * - StrokePreview: Real-time stroke preview canvas (implemented in Phase 3 Step 3)
 */
export const BrushOverlayMain = React.memo(function BrushOverlayMain() {
  const { isBrushMode, activeCraft } = useBrushOverlayState();

  if (!isBrushMode) return null;

  return (
    <>
      <BrushCursor isEraser={activeCraft === 'eraser'} />
      <StrokePreview />
    </>
  );
});

// ─── BrushCursor ───────────────────────────────────────────────────────────────

/**
 * BrushCursor: Double-layer circular brush cursor
 *
 * Design:
 * - Outer ring: 1px translucent white circle (always visible on any background)
 * - Inner ring: 1px translucent black circle (ensures visibility on white background)
 * - Center point: 2px crosshair (precise positioning)
 * - Fill: 10% opacity preview of the current color (lets the user know what color will be painted)
 * - Eraser mode: dashed circle + no color fill
 *
 * Diameter = brushSize * camera.k (automatically adjusts screen size with zoom)
 * Follows the mouse at 60fps via useBrushCursorTracking (zero React redraw)
 */
interface BrushCursorProps {
  isEraser: boolean;
}

const BrushCursor = React.memo(function BrushCursor({ isEraser }: BrushCursorProps) {
  const cursorRef = useRef<HTMLDivElement>(null);
  const { brushSize } = useBrushParams();
  const brushColor = useBrushColor();
  const { activeFrame } = useEditorState();

  // 60fps mouse position tracking + camera.k real-time sync size + Cmd/Ctrl modifier key listening
  useBrushCursorTracking(cursorRef, true, brushSize);

  // Calculate cursor diameter on screen (brushSize * camera zoom ratio)
  const cameraK = activeFrame?.camera.k || 1;
  const screenDiameter = Math.max(brushSize * cameraK, 4); // minimum 4px visible
  const halfSize = screenDiameter / 2;

  return (
    <div
      ref={cursorRef}
      className="absolute top-0 left-0 pointer-events-none"
      style={{
        opacity: 0, // initially hidden, shown on mousemove
        willChange: 'transform',
        zIndex: 9999,
        // translate aligns circle center with mouse
        marginLeft: `-${halfSize}px`,
        marginTop: `-${halfSize}px`,
      }}
    >
      {/* Outer ring: white stroke */}
      <div
        className="absolute rounded-full"
        style={{
          width: `${screenDiameter}px`,
          height: `${screenDiameter}px`,
          border: isEraser
            ? '1px dashed rgba(255, 255, 255, 0.8)'
            : '1px solid rgba(255, 255, 255, 0.8)',
          boxSizing: 'border-box',
        }}
      />

      {/* Inner ring: black stroke (offset 1px inward contraction) */}
      <div
        className="absolute rounded-full"
        style={{
          width: `${screenDiameter - 2}px`,
          height: `${screenDiameter - 2}px`,
          left: '1px',
          top: '1px',
          border: isEraser
            ? '1px dashed rgba(0, 0, 0, 0.5)'
            : '1px solid rgba(0, 0, 0, 0.5)',
          boxSizing: 'border-box',
        }}
      />

      {/* Color fill preview (brush mode only, eraser not shown) */}
      {!isEraser && screenDiameter > 6 && (
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

      {/* Tool identity badge (bottom-right): droplet (brush) or × (eraser) */}
      <svg
        data-badge="tool-id"
        className="absolute pointer-events-none"
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        style={{
          left: `${Math.max(screenDiameter - 1, halfSize + 2)}px`,
          top: `${Math.max(screenDiameter - 1, halfSize + 2)}px`,
          filter: 'drop-shadow(0 0.5px 1px rgba(0,0,0,0.9))',
        }}
      >
        {isEraser ? (
          /* × symbol: two crossed lines */
          <>
            <line x1="2" y1="2" x2="8" y2="8" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
            <line x1="8" y1="2" x2="2" y2="8" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
          </>
        ) : (
          /* Droplet: teardrop shape, filled white */
          <path d="M5 1C5 1 2 4.5 2 6.5C2 8.5 3.3 9.5 5 9.5C6.7 9.5 8 8.5 8 6.5C8 4.5 5 1 5 1Z" fill="white" />
        )}
      </svg>

      {/* "+" new layer indicator badge: displayed when Cmd/Ctrl is pressed (bottom right) */}
      <div
        data-badge="new-layer"
        className="absolute"
        style={{
          opacity: 0, // hidden by default, dynamically controlled by keydown/keyup in hooks
          left: `${screenDiameter - 2}px`,
          top: `${screenDiameter - 2}px`,
          width: '12px',
          height: '12px',
          borderRadius: '50%',
          backgroundColor: 'var(--accent, #6366f1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '9px',
          fontWeight: 900,
          color: '#fff',
          lineHeight: 1,
          boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
          transition: 'opacity 0.1s ease',
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
 *
 * Renders a <canvas> element in the STAGE_OVERLAY layer to display the current stroke in real time.
 *
 * Implementation points:
 * - canvas physical dimensions = document canvas dimensions (consistent with Stroke Buffer)
 * - Follows camera using CSS transform (translate + scale), no drawImage scaling needed
 * - Detects strokeVersion change per frame via useFastSync Ticker, calls drawImage only when dirty
 * - Clears canvas when stroke ends (isStroking=false)
 */
const StrokePreview = React.memo(function StrokePreview() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastVersionRef = useRef<number>(0);
  const lastCamRef = useRef<{ x: number; y: number; k: number } | null>(null);
  const isCleanRef = useRef<boolean>(true);
  const lastWidthRef = useRef<number>(0);
  const lastHeightRef = useRef<number>(0);
  const { activeFrame } = useEditorState();
  const { activeCraft } = useBrushOverlayState();

  const isMaskTool = activeCraft === 'eraser' || activeCraft === 'restore';

  const canvasW = activeFrame?.camera ? activeFrame.canvas.w : 0;
  const canvasH = activeFrame?.camera ? activeFrame.canvas.h : 0;

  // useFastSync: follows camera per frame + detects stroke buffer update
  useFastSync(containerRef, true, (_v: VolatileState, f: Frame, cam: CameraState) => {
    const el = containerRef.current;
    const cvs = canvasRef.current;
    if (!el || !cvs) return;

    if (cvs.width !== lastWidthRef.current || cvs.height !== lastHeightRef.current) {
      lastWidthRef.current = cvs.width;
      lastHeightRef.current = cvs.height;
      isCleanRef.current = true;
    }

    // Positioning: canvas top-left corner (0,0) screen position
    const camChanged = !lastCamRef.current ||
      lastCamRef.current.x !== cam.x ||
      lastCamRef.current.y !== cam.y ||
      lastCamRef.current.k !== cam.k;

    if (camChanged) {
      lastCamRef.current = { x: cam.x, y: cam.y, k: cam.k };
      const screenX = cam.x;
      const screenY = cam.y;
      el.style.transform = `translate(${screenX}px, ${screenY}px) scale(${cam.k})`;
    }

    // Detect strokeVersion changes -> redraw preview
    const currentVersion = getStrokeVersion();
    const versionChanged = currentVersion !== lastVersionRef.current;
    if (versionChanged) {
      lastVersionRef.current = currentVersion;
    }

    const strokeCanvas = getStrokeBuffer();
    const hasStroke = strokeCanvas && !isMaskTool;

    if (versionChanged) {
      const ctx = cvs.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, cvs.width, cvs.height);
        if (hasStroke) {
          ctx.drawImage(strokeCanvas, 0, 0);
          isCleanRef.current = false;
        } else {
          isCleanRef.current = true;
        }
      }
    } else if (!hasStroke && !isCleanRef.current && cvs.width > 0) {
      const ctx = cvs.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, cvs.width, cvs.height);
        isCleanRef.current = true;
      }
    }
  });

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
