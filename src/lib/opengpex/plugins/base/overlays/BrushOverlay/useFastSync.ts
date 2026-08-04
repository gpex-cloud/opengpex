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

import { useRef } from 'react';
import { useFastSync } from '@opengpex/editor/core/motion/hooks/navigation';
import { VolatileState, Frame, CameraState } from '@opengpex/editor/core/types';
import { getStrokeBuffer, getStrokeVersion } from './interactions';

/**
 * useStrokePreviewFastSync: Stroke preview camera follow + dirty detection.
 *
 * Follows camera via CSS transform and detects strokeVersion changes to trigger
 * canvas drawImage only when the stroke buffer is actually dirty.
 * [P0 Perf] Throttled to ~60Hz during interaction.
 */
export function useStrokePreviewFastSync(
  containerRef: React.RefObject<HTMLDivElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  isMaskTool: boolean,
) {
  const lastVersionRef = useRef<number>(0);
  const lastCamRef = useRef<{ x: number; y: number; k: number } | null>(null);
  const isCleanRef = useRef<boolean>(true);
  const lastWidthRef = useRef<number>(0);
  const lastHeightRef = useRef<number>(0);

  useFastSync(containerRef, true, (_v: VolatileState, _f: Frame, cam: CameraState) => {
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
      el.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`;
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
  }, { throttleHz: 60 });
}

/**
 * useMaskFocusOverlayFastSync: Mask focus overlay camera follow.
 *
 * Positions the mask overlay to follow camera via CSS transform.
 * [P0 Perf] Throttled to ~60Hz during interaction.
 */
export function useMaskFocusOverlayFastSync(
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  useFastSync(containerRef, true, (_v: VolatileState, _f: Frame, cam: CameraState) => {
    const el = containerRef.current;
    if (!el) return;
    el.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`;
  }, { throttleHz: 60 });
}

/**
 * useBrushCursorFastSync: Brush cursor size synchronization with camera.k.
 *
 * Resizes cursor DOM elements when camera zoom changes.
 * [P0 Perf] Throttled to ~60Hz during interaction.
 */
export function useBrushCursorFastSync(
  cursorRef: React.RefObject<HTMLDivElement | null>,
  isActive: boolean,
  brushSize: number,
) {
  const lastCameraKRef = useRef<number>(1);

  useFastSync(cursorRef, isActive, (_v: VolatileState, _f: Frame, cam: CameraState) => {
    const el = cursorRef.current;
    if (!el) return;

    const cameraK = cam.k;
    if (Math.abs(cameraK - lastCameraKRef.current) < 0.001) return; // Skip if no change
    lastCameraKRef.current = cameraK;

    // Calculate new screen diameter
    const screenDiameter = Math.max(brushSize * cameraK, 4);
    const halfSize = screenDiameter / 2;

    // Update margin (align cursor center with pointer position)
    el.style.marginLeft = `-${halfSize}px`;
    el.style.marginTop = `-${halfSize}px`;

    // Update dimensions of all child elements
    const children = el.children;
    // Outer ring
    if (children[0]) {
      (children[0] as HTMLElement).style.width = `${screenDiameter}px`;
      (children[0] as HTMLElement).style.height = `${screenDiameter}px`;
    }
    // Inner ring
    if (children[1]) {
      (children[1] as HTMLElement).style.width = `${screenDiameter - 2}px`;
      (children[1] as HTMLElement).style.height = `${screenDiameter - 2}px`;
    }
    // Color fill (if present)
    if (children[2] && (children[2] as HTMLElement).classList.contains('rounded-full')) {
      (children[2] as HTMLElement).style.width = `${screenDiameter - 4}px`;
      (children[2] as HTMLElement).style.height = `${screenDiameter - 4}px`;
      (children[2] as HTMLElement).style.display = screenDiameter > 6 ? '' : 'none';
    }
    // Crosshair
    const crossV = el.querySelector('[data-cross="v"]') as HTMLElement;
    const crossH = el.querySelector('[data-cross="h"]') as HTMLElement;
    if (crossV) {
      crossV.style.left = `${halfSize - 0.5}px`;
      crossV.style.top = `${halfSize - 3}px`;
    }
    if (crossH) {
      crossH.style.left = `${halfSize - 3}px`;
      crossH.style.top = `${halfSize - 0.5}px`;
    }

    // Tool identity badge (bottom-right of cursor circle/square)
    const toolBadge = el.querySelector('[data-badge="tool-id"]') as HTMLElement;
    if (toolBadge) {
      const badgeOffset = Math.max(screenDiameter - 1, halfSize + 2);
      toolBadge.style.left = `${badgeOffset}px`;
      toolBadge.style.top = `${badgeOffset}px`;
    }

    // Mode indicator badge (right of tool badge)
    const modeBadge = el.querySelector('[data-badge="new-layer"]') as HTMLElement;
    if (modeBadge) {
      const badgeOffset = Math.max(screenDiameter - 1, halfSize + 2);
      modeBadge.style.left = `${badgeOffset + 17}px`;
      modeBadge.style.top = `${badgeOffset + 1}px`;
    }
  }, { throttleHz: 60 });
}
