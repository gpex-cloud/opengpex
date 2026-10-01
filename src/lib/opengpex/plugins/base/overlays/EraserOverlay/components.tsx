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

import React, { useRef, useEffect } from 'react';
import { useEditorState } from '@opengpex/editor/core/context';
import { useEraserOverlayState, useBrushCursorTracking, useBrushParams } from './hooks';
import { useStrokePreviewFastSync, useMaskFocusOverlayFastSync } from './useFastSync';
import { MASK_EDITING_KEY, MASK_FOCUS_KEY, type MaskEditingSignal } from '../../drawers/LayersDrawer/protocols';

// ─── EraserOverlayMain ─────────────────────────────────────────────────────────

/**
 * EraserOverlayMain: Eraser/restore overlay main component.
 *
 * Render in STAGE_OVERLAY layer:
 * - MaskFocusOverlay: rubylith highlight of the mask being edited
 * - BrushCursor: dashed circular cursor (follows mouse, 60fps DOM manipulation)
 * - StrokePreview: kept clear — mask preview is rendered by the engine via fast.override
 */
export const EraserOverlayMain = React.memo(function EraserOverlayMain() {
  const { isEraserMode, activeCraft } = useEraserOverlayState();

  if (!isEraserMode) return null;

  return (
    <>
      <MaskFocusOverlay />
      <BrushCursor activeCraft={activeCraft || 'eraser'} />
      <StrokePreview />
    </>
  );
});

// ─── BrushCursor ───────────────────────────────────────────────────────────────

/**
 * BrushCursor: Dashed circular eraser/restore cursor.
 *
 * Design:
 * - Outer ring: 1px dashed translucent white circle
 * - Inner ring: 1px dashed translucent black circle (visible on white background)
 * - Center point: 2px crosshair (precise positioning)
 * - No color fill (mask edits are colourless)
 *
 * Diameter = brushSize * camera.k (automatically adjusts screen size with zoom)
 * Follows the mouse at 60fps via useBrushCursorTracking (zero React redraw).
 */
interface BrushCursorProps {
  activeCraft: string;
}

const BrushCursor = React.memo(function BrushCursor({ activeCraft }: BrushCursorProps) {
  const cursorRef = useRef<HTMLDivElement>(null);
  const { brushSize } = useBrushParams();
  const { activeFrame } = useEditorState();

  // 60fps mouse position tracking + camera.k real-time sync size + Cmd/Ctrl modifier key listening
  useBrushCursorTracking(cursorRef, true, brushSize, activeCraft);

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
      {/* Outer ring: white dashed stroke */}
      <div
        className="absolute rounded-full"
        style={{
          width: `${screenDiameter}px`,
          height: `${screenDiameter}px`,
          border: '1px dashed rgba(255, 255, 255, 0.8)',
          boxSizing: 'border-box',
        }}
      />

      {/* Inner ring: black dashed stroke (offset 1px inward contraction) */}
      <div
        className="absolute rounded-full"
        style={{
          width: `${screenDiameter - 2}px`,
          height: `${screenDiameter - 2}px`,
          left: '1px',
          top: '1px',
          border: '1px dashed rgba(0, 0, 0, 0.5)',
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

      {/* Tool identity badge (bottom-right): eraser icon (used for both eraser and restore) */}
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
        {/* Eraser icon (matches lucide Eraser) */}
        <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M22 21H7" stroke="white" strokeWidth="3" strokeLinecap="round" />
      </svg>

      {/* Mode indicator badge: "+" (eraser + Cmd, controlled imperatively by hooks.ts) / undo-2 (restore, always visible) */}
      <div
        data-badge="new-layer"
        className="absolute"
        style={{
          // restore: always visible; eraser: hidden by default, hooks.ts toggles on Cmd press
          opacity: activeCraft === 'restore' ? 1 : 0,
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
          // No CSS transition — prevents flash of "+" during restore→eraser switch.
          // Imperative show/hide in hooks.ts is already instant.
        }}
      >
        {activeCraft === 'restore' ? (
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none">
            <path d="M9 14 4 9l5-5" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          '+'
        )}
      </div>
    </div>
  );
});

// ─── StrokePreview ─────────────────────────────────────────────────────────────

/**
 * StrokePreview: camera-following overlay canvas kept clear for mask tools.
 *
 * Mask edits are previewed by the real render pipeline through `fast.override`
 * on the target layer, not through a stroke buffer. This canvas therefore stays
 * empty; it exists to mirror the raster overlay's structure and camera follow.
 */
const StrokePreview = React.memo(function StrokePreview() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { activeFrame } = useEditorState();

  const canvasW = activeFrame?.camera ? activeFrame.canvas.w : 0;
  const canvasH = activeFrame?.camera ? activeFrame.canvas.h : 0;

  // Camera follow (extracted to useFastSync.ts)
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

// ─── MaskFocusOverlay ──────────────────────────────────────────────────────────

/**
 * MaskFocusOverlay: Rubylith-style overlay showing masked (hidden) areas.
 *
 * When maskEditing signal is set AND maskFocus signal is true:
 * - Loads the bitmap mask being edited
 * - Renders a semi-transparent green tint over areas revealed by the mask
 * - Helps the user visualize what's masked vs visible
 *
 * Follows camera via useFastSync (same positioning as StrokePreview).
 */
const MaskFocusOverlay = React.memo(function MaskFocusOverlay() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { activeFrame, state } = useEditorState();

  const maskEditing = state.interaction.signals[MASK_EDITING_KEY] as MaskEditingSignal;
  const maskFocus = state.interaction.signals[MASK_FOCUS_KEY] as boolean ?? true;

  // Resolve layer & mask
  const layer = maskEditing && activeFrame ? activeFrame.layers.byId[maskEditing.layerId] : null;
  const mask = layer?.bitmapMasks?.find(m => m.id === maskEditing?.maskId);

  const canvasW = activeFrame?.canvas?.w || 0;
  const canvasH = activeFrame?.canvas?.h || 0;

  // Load mask image and render green highlight overlay
  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs || !mask || !maskFocus || !layer || !canvasW || !canvasH) {
      if (cvs) {
        const ctx = cvs.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, cvs.width, cvs.height);
      }
      return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const ctx = cvs.getContext('2d');
      if (!ctx) return;

      ctx.clearRect(0, 0, cvs.width, cvs.height);

      const lw = layer.bounding.w;
      const lh = layer.bounding.h;
      const lx = layer.cx + canvasW / 2 - lw / 2;
      const ly = layer.cy + canvasH / 2 - lh / 2;

      // Mask placement inside the layer's bounding-local space.
      // `bounds.x/y` is non-zero for fragment layers (the mask is anchored to
      // visibleShape.rect, see LayerUtils.getMaskOrigin), so the highlight must
      // be offset by it — otherwise the green preview would sit somewhere the
      // mask does not actually apply. Falls back to the full bounding rect for
      // legacy masks persisted without an offset.
      const mb = mask.bounds;
      const mx = lx + (mb?.x ?? 0);
      const my = ly + (mb?.y ?? 0);
      const mw = mb?.w ?? lw;
      const mh = mb?.h ?? lh;

      // Green semi-transparent highlight over visible mask areas
      ctx.fillStyle = 'rgba(34, 197, 94, 0.4)';
      ctx.fillRect(mx, my, mw, mh);

      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(img, mx, my, mw, mh);
      ctx.globalCompositeOperation = 'source-over';
    };
    img.src = mask.src;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mask?.src, mask?.bounds?.x, mask?.bounds?.y, mask?.bounds?.w, mask?.bounds?.h, maskFocus, maskEditing?.layerId, maskEditing?.maskId, layer?.cx, layer?.cy, layer?.bounding?.w, layer?.bounding?.h, canvasW, canvasH]);

  // Follow camera positioning (extracted to useFastSync.ts)
  useMaskFocusOverlayFastSync(containerRef);

  // Don't render if no mask editing or focus disabled
  if (!maskEditing || !maskFocus || !activeFrame || !layer || !mask || !canvasW || !canvasH) return null;

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
        }}
      />
    </div>
  );
});
