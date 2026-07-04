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

import {
  InteractionHandler,
  LocalPoint,
  Frame,
  GeometryService,
  asLocalPoint,
  asLocalRect,
  asLocalPolygon,
} from '@opengpex/editor/core/types';
import { computePolygonBounds, computeRingArea } from '@opengpex/editor/core/geometry/operators/polygon';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { ClipOptionsAPI } from '../../../options/ClipOptions/protocols';
import { makeCropToolGuard } from './guard';

/**
 * lassoPreviewPathRef
 *
 * Module-level shared ref slot for the live lasso preview SVG <path>. The
 * ClipOverlay component (`components.tsx`) installs the DOM element here on
 * mount, and `createLassoHandler` reads it during `onStart` / `onMove` / `onEnd`
 * to update the screen-space `d` attribute **without going through React or
 * the redux store**.
 *
 * Rationale: the lasso trail is a high-frequency, throwaway visual — pushing
 * it through `setIrregularCropBox` per pointermove would (a) spam the undo
 * stack, (b) re-render the entire React tree, (c) defeat fast-track. Mirrors
 * the BrushOverlay's "draw on offscreen canvas, commit on pointerup" pattern.
 */
export const lassoPreviewPathRef: { current: SVGPathElement | null } = { current: null };

// ─── Internal Helpers ──────────────────────────────────────────────────────────

/**
 * Encode a frame-local LocalPoint trail into a screen-space SVG `d` attribute.
 * The lasso preview path lives at viewport (0, 0) (no group transform), so we
 * project frame-local → screen on every emit.
 *
 * We deliberately do NOT append a trailing `Z` here: while the user is still
 * dragging, the polygon is unfinished and a closing segment would spuriously
 * connect the cursor back to the start point.
 */
function buildScreenPathD(
  trail: LocalPoint[],
  e: { activeFrame: Frame; geometry: GeometryService }
): string {
  if (trail.length < 2) return '';
  const segs: string[] = [];
  for (let i = 0; i < trail.length; i++) {
    const p = trail[i];
    const sp = e.geometry.space.localToScreen(p.x, p.y, e.activeFrame);
    segs.push(`${i === 0 ? 'M' : 'L'} ${sp.x} ${sp.y}`);
  }
  return segs.join(' ');
}

// Dev-only trace for debugging lasso event dispatch issues.
const LASSO_TRACE = false;
function lassoTrace(...args: unknown[]) {
  if (LASSO_TRACE) console.info('[Lasso]', ...args);
}

function clearPreview() {
  if (lassoPreviewPathRef.current) {
    lassoPreviewPathRef.current.setAttribute('d', '');
  }
}

// ─── Handler ───────────────────────────────────────────────────────────────────

/**
 * createLassoHandler — free-form polygon selection
 *
 * Lifecycle:
 *   onStart     start trail with first frame-local point + clear preview
 *   onMove      append point, repaint preview path d (screen space, no redux)
 *   onEnd       (≥3 points) → compute bounds → asLocalPolygon → write clip slot
 *               always clear preview + reset trail
 */
export const createLassoHandler = (): InteractionHandler => {
  let trail: LocalPoint[] = [];
  let active = false;
  // Cached AA state for the current gesture — read once at onStart.
  let gestureAA = true;

  return {
    id: 'clip-lasso',
    priority: 110,

    test: (e) => {
      if (!makeCropToolGuard('lasso')(e)) return false;

      const me = e.nativeEvent as MouseEvent;
      if (me.button === 2) return false;
      const target = me.target as HTMLElement;
      if (target.closest('button, a, input, [data-role="ui"], [contenteditable]')) return false;

      const frame = e.activeFrame;
      return e.geometry.space.isPointInRect(e.point.canvas, {
        x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h,
      });
    },

    onStart: (e) => {
      active = true;
      const clipBox = getClipBox(e.activeFrame);
      gestureAA = clipBox?.spatial.antiAliased ?? true;

      let { x: clampedX, y: clampedY } = e.geometry.space.clampPointToRect(e.point.canvas, e.activeFrame.canvas);
      if (!gestureAA) {
        const snapped = e.geometry.snapping.snapToPixel({ x: clampedX, y: clampedY });
        clampedX = snapped.x;
        clampedY = snapped.y;
      }
      trail = [asLocalPoint({ x: clampedX, y: clampedY })];
      if (lassoPreviewPathRef.current) {
        const sp = e.geometry.space.localToScreen(clampedX, clampedY, e.activeFrame);
        lassoPreviewPathRef.current.setAttribute('d', `M ${sp.x} ${sp.y}`);
      }
      lassoTrace('onStart', 'trail=', trail.length, 'previewRef=', !!lassoPreviewPathRef.current, 'aa=', gestureAA);
    },

    onMove: (e) => {
      if (!active) return;
      let { x: clampedX, y: clampedY } = e.geometry.space.clampPointToRect(e.point.canvas, e.activeFrame.canvas);
      if (!gestureAA) {
        const snapped = e.geometry.snapping.snapToPixel({ x: clampedX, y: clampedY });
        clampedX = snapped.x;
        clampedY = snapped.y;
      }
      const p = asLocalPoint({ x: clampedX, y: clampedY });
      trail.push(p);
      if (lassoPreviewPathRef.current) {
        lassoPreviewPathRef.current.setAttribute('d', buildScreenPathD(trail, e));
      }
      if (trail.length % 5 === 0) {
        lassoTrace('onMove', 'trail=', trail.length);
      }
    },

    onEnd: (e) => {
      let committed = false;
      try {
        if (!active) return;

        // Double-click to clear lasso selection.
        if (trail.length < 3) {
          if ((e.nativeEvent as MouseEvent).detail === 2) {
            e.actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);
          }
          return;
        }

        const ring = trail.slice();

        // Area validation: discard micro-drags.
        const MIN_LASSO_AREA = 8;
        if (computeRingArea(ring) < MIN_LASSO_AREA) {
          return;
        }

        const bounds = computePolygonBounds([ring]);
        const polygon = asLocalPolygon([ring], asLocalRect(bounds), gestureAA);
        e.actions.setClipBox(e.activeFrame.id, 'lasso', polygon);
        committed = true;

      } finally {
        lassoTrace('onEnd  ', 'trail=', trail.length, 'committed=', committed);
        trail = [];
        active = false;
        gestureAA = true;
        clearPreview();
      }
    },
  };
};
