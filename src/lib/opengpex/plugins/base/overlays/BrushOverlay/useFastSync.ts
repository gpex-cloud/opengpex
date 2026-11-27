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
import { BRUSH_STABILIZER_GUIDE_KEY, type BrushStabilizerGuide } from './protocols';

/**
 * useBrushCursorFastSync: resize the brush ring when the camera zoom changes,
 * so the ring always covers exactly the pixels the stroke will paint.
 *
 * [Perf] Throttled to ~60Hz and short-circuited when `camera.k` is unchanged.
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

/**
 * useBrushStabilizerGuideFastSync: draw the rope-model stabilizer's
 * pull-string guide — a dotted line from the pointer to the rope point plus a
 * small dot at the rope end — so the stabilizer's intentional lag reads as a
 * feature instead of a pointer that "doesn't keep up".
 *
 * Both elements are hidden when the guide transient is absent or no gesture
 * is in flight; while visible, positions are re-projected every throttled
 * tick. Note the `useFastSync` contract: only `lineRef` gets the automatic
 * null-guard; `anchorRef` must be null-checked inside the callback.
 */
export function useBrushStabilizerGuideFastSync(
  lineRef: React.RefObject<SVGLineElement | null>,
  anchorRef: React.RefObject<SVGCircleElement | null>,
  isActive: boolean,
) {
  // Skip-write caches: without them this hook writes two identical inline
  // styles per ticker frame while idle (the 60Hz throttle only runs during
  // interaction) and six identical SVG attributes per tick whenever the
  // pointer holds still mid-drag — SVG setAttribute always re-runs the
  // attribute-changed steps even for an unchanged value, dirty-marking the
  // element for nothing. Initial `hidden = true` matches the JSX defaults,
  // so a remount needs no extra reset.
  const hiddenRef = useRef(true);
  const lastCoordsRef = useRef<number[]>([]);

  useFastSync(lineRef, isActive, (v: VolatileState, _f: Frame, cam: CameraState) => {
    const line = lineRef.current;
    const anchor = anchorRef.current;
    if (!line || !anchor) return;

    const guide = v.transient[BRUSH_STABILIZER_GUIDE_KEY] as unknown as
      | BrushStabilizerGuide
      | undefined;
    if (!guide || !v.activeState.interacting) {
      if (!hiddenRef.current) {
        line.style.display = 'none';
        anchor.style.display = 'none';
        hiddenRef.current = true;
        lastCoordsRef.current = [];
      }
      return;
    }

    const x1 = cam.x + guide.pointerCanvas.x * cam.k;
    const y1 = cam.y + guide.pointerCanvas.y * cam.k;
    const x2 = cam.x + guide.ropeCanvas.x * cam.k;
    const y2 = cam.y + guide.ropeCanvas.y * cam.k;

    const last = lastCoordsRef.current;
    if (
      last.length === 4 &&
      last[0] === x1 && last[1] === y1 && last[2] === x2 && last[3] === y2
    ) {
      return;
    }
    lastCoordsRef.current = [x1, y1, x2, y2];

    line.setAttribute('x1', `${x1}`);
    line.setAttribute('y1', `${y1}`);
    line.setAttribute('x2', `${x2}`);
    line.setAttribute('y2', `${y2}`);
    anchor.setAttribute('cx', `${x2}`);
    anchor.setAttribute('cy', `${y2}`);
    if (hiddenRef.current) {
      line.style.display = '';
      anchor.style.display = '';
      hiddenRef.current = false;
    }
  }, { throttleHz: 60 });
}
