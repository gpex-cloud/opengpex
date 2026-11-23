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
import { EDITOR_Z_INDEX } from '@opengpex/editor/core/helpers/config';
import { useRetouchOverlayState, useRetouchCursorTracking, useRetouchParams } from './hooks';
import { useStrokePreviewFastSync } from './useFastSync';
import { RETOUCH_MODE_ICONS } from '../../drawers/CraftDrawer/icon';
import { useCloneGhostTracking } from './hooks';

// ─── RetouchOverlayMain ─────────────────────────────────────────────────────────

/**
 * RetouchOverlayMain: Mosaic overlay main component
 *
 * Render in STAGE_OVERLAY layer:
 * - RetouchCursor: Circular cursor with checkerboard badge (follows mouse, 60fps DOM manipulation)
 * - StrokePreview: Real-time stroke preview canvas
 */
export const RetouchOverlayMain = React.memo(function RetouchOverlayMain() {
  const { isMosaicMode } = useRetouchOverlayState();

  if (!isMosaicMode) return null;

  return (
    <>
      <RetouchCursor />
      <CloneSourceMarker />
      <StrokePreview />
    </>
  );
});

// ─── CloneSourceMarker ─────────────────────────────────────────────────────────

/**
 * CloneSourceMarker: the sampling-origin indicator for clone mode (the
 * Photoshop twin-cursor affordance) — while the user paints, a crosshair ring
 * stays pinned at the picked source point so they can SEE where pixels are
 * being copied from.
 *
 * The anchor lives in module state (picked from non-React interaction code),
 * so the component subscribes via useSyncExternalStore. Camera follow reuses
 * the StrokePreview idiom: one container div transformed per tick by the
 * volatile fast-sync channel, with the marker positioned at the anchor in
 * canvas coordinates inside it.
 */
const CloneSourceMarker = React.memo(function CloneSourceMarker() {
  const { mode, brushDiameter } = useRetouchParams();
  // CONTROL lives in useCloneGhostTracking (pointer capture, camera math,
  // visibility policy, fast-sync); this component only renders the bound DOM.
  const { containerRef, ghostRef, source } = useCloneGhostTracking();

  if (!source || mode !== 'clone') return null;

  return (
    <div
      ref={containerRef}
      className="absolute top-0 left-0 pointer-events-none"
      style={{ transformOrigin: '0 0', willChange: 'transform', zIndex: EDITOR_Z_INDEX.FULLSCREEN.OVERLAY }}
    >
      {/* Sized to the brush diameter in CANVAS units — the container's scale(k)
          makes it render exactly as large as the on-screen brush ring, so the
          source preview always matches what the stroke will stamp. */}
      {/* Solid double-ring marker: the picked source anchor (static origin). */}
      <div style={{ position: 'absolute', left: source.anchor.x, top: source.anchor.y, transform: 'translate(-50%, -50%)' }}>
        <svg width={brushDiameter} height={brushDiameter} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          {/* Double ring: white outer / dark inner for visibility on any backdrop */}
          <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.95)" strokeWidth="0.7" />
          <circle cx="12" cy="12" r="8.4" stroke="rgba(0,0,0,0.65)" strokeWidth="0.5" />
          {/* Center crosshair */}
          <path d="M12 7.5v9M7.5 12h9" stroke="rgba(255,255,255,0.95)" strokeWidth="0.6" style={{ filter: 'drop-shadow(0 0 0.5px rgba(0,0,0,0.7))' }} />
        </svg>
      </div>
      {/* Dashed ghost ring: WHERE the next stamp will copy FROM — follows the
          pointer's aligned sample position, brush-sized so it previews the
          copied area. Hidden while Alt picks a new source. */}
      <div
        ref={ghostRef}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          opacity: 0,
          transform: 'translate(-9999px, -9999px)',
        }}
      >
        <div style={{ transform: 'translate(-50%, -50%)' }}>
          <svg width={brushDiameter} height={brushDiameter} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.95)" strokeWidth="0.7" strokeDasharray="3 2.5" />
            <circle cx="12" cy="12" r="10" stroke="rgba(0,0,0,0.65)" strokeWidth="0.5" strokeDasharray="3 2.5" transform="translate(0.6 0.6)" />
            <circle cx="12" cy="12" r="0.9" fill="rgba(255,255,255,0.95)" />
          </svg>
        </div>
      </div>
    </div>
  );
});

// ─── RetouchCursor ──────────────────────────────────────────────────────────────

/**
 * RetouchCursor: Double-layer circular cursor for mosaic tool
 *
 * Follows the mouse at 60fps via useRetouchCursorTracking (zero React redraw).
 */
const RetouchCursor = React.memo(function RetouchCursor() {
  const cursorRef = useRef<HTMLDivElement>(null);
  const { brushDiameter, mode } = useRetouchParams();
  const ModeBadgeIcon = RETOUCH_MODE_ICONS[mode];
  const { activeFrame } = useEditorState();

  useRetouchCursorTracking(cursorRef, true, brushDiameter);

  const cameraK = activeFrame?.camera.k || 1;
  const screenDiameter = Math.max(brushDiameter * cameraK, 4);
  const halfSize = screenDiameter / 2;

  return (
    <div
      ref={cursorRef}
      data-cursor-indicator
      className="absolute top-0 left-0 pointer-events-none"
      style={{
        opacity: 0,
        willChange: 'transform',
        zIndex: EDITOR_Z_INDEX.FULLSCREEN.OVERLAY,
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

      {/* Tool identity badge (bottom-right): the ACTIVE retouch mode's glyph —
          every mode gets its own cursor badge instead of a fixed mosaic mark. */}
      <div
        data-badge="tool-id"
        className="absolute pointer-events-none"
        style={{
          left: `${Math.max(screenDiameter - 1, halfSize + 2)}px`,
          top: `${Math.max(screenDiameter - 1, halfSize + 2)}px`,
          color: '#fff',
          filter: 'drop-shadow(0 0.5px 1px rgba(0,0,0,0.9))',
        }}
      >
        <ModeBadgeIcon size={14} />
      </div>

      {/* Clone pick-source badge: crosshair glyph shown while Alt is held
          in clone mode (visibility driven by the spring `alt` channel in
          useRetouchCursorTracking; hidden in every other mode — the badge is
          only rendered when the active mode is clone). */}
      {mode === 'clone' && (
        <div
          data-badge="clone-source"
          className="absolute"
          style={{
            opacity: 0,
            left: `${Math.max(screenDiameter - 1, halfSize + 2) + 17}px`,
            top: `${Math.max(screenDiameter - 1, halfSize + 2) + 1}px`,
            width: '14px',
            height: '14px',
            borderRadius: '50%',
            backgroundColor: 'var(--accent, #6366f1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 1,
            boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M5 0.5V3.2M5 6.8V9.5M0.5 5H3.2M6.8 5H9.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="5" cy="5" r="1.1" fill="#fff" />
          </svg>
        </div>
      )}
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
