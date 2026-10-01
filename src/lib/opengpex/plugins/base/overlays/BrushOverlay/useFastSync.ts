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

/**
 * useFastSync.ts — Ticker-driven (non-React) synchronizers for BrushOverlay.
 *
 * @module plugins/base/overlays/BrushOverlay/useFastSync
 */

import { useRef } from 'react';
import { useFastSync } from '@opengpex/editor/core/state/volatile';
import { VolatileState, Frame, CameraState } from '@opengpex/editor/core/types';

/**
 * useBrushCursorFastSync: resize the brush ring when the camera zoom changes,
 * so the ring always covers exactly the pixels the stroke will paint.
 *
 * [P0 Perf] Throttled to ~60Hz and short-circuited when `camera.k` is unchanged.
 * Child order is the contract with `components.tsx`: [0] outer ring,
 * [1] inner ring, [2] colour fill; the crosshair bars carry `data-cross`.
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
    if (Math.abs(cameraK - lastCameraKRef.current) < 0.001) return;
    lastCameraKRef.current = cameraK;

    const screenDiameter = Math.max(brushSize * cameraK, 4);
    const halfSize = screenDiameter / 2;

    // Keep the ring centred on the pointer as it grows.
    el.style.marginLeft = `-${halfSize}px`;
    el.style.marginTop = `-${halfSize}px`;

    const children = el.children;
    if (children[0]) {
      (children[0] as HTMLElement).style.width = `${screenDiameter}px`;
      (children[0] as HTMLElement).style.height = `${screenDiameter}px`;
    }
    if (children[1]) {
      (children[1] as HTMLElement).style.width = `${screenDiameter - 2}px`;
      (children[1] as HTMLElement).style.height = `${screenDiameter - 2}px`;
    }
    if (children[2] && (children[2] as HTMLElement).classList.contains('rounded-full')) {
      (children[2] as HTMLElement).style.width = `${screenDiameter - 4}px`;
      (children[2] as HTMLElement).style.height = `${screenDiameter - 4}px`;
      (children[2] as HTMLElement).style.display = screenDiameter > 6 ? '' : 'none';
    }

    const crossV = el.querySelector('[data-cross="v"]') as HTMLElement | null;
    const crossH = el.querySelector('[data-cross="h"]') as HTMLElement | null;
    if (crossV) {
      crossV.style.left = `${halfSize - 0.5}px`;
      crossV.style.top = `${halfSize - 3}px`;
    }
    if (crossH) {
      crossH.style.left = `${halfSize - 3}px`;
      crossH.style.top = `${halfSize - 0.5}px`;
    }
  }, { throttleHz: 60 });
}
