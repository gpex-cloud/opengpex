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
/**
 * Snap-to-start threshold in screen pixels.
 * Uses the same dynamic-threshold concept from core/geometry/operators/snapping.ts:
 *   screenThreshold / cameraScale → constant visual radius regardless of zoom.
 */
const SNAP_TO_START_SCREEN_PX = 10;

export const createLassoHandler = (): InteractionHandler => {
  let trail: LocalPoint[] = [];
  let active = false;
  // Cached AA state for the current gesture — read once at onStart.
  let gestureAA = true;
  // Whether the current pointer is snapped to start (within threshold).
  let snappedToStart = false;

  return {
    id: 'clip-lasso',
    priority: 110,

    test: (e) => {
      if (!makeCropToolGuard('lasso')(e)) return false;

      const me = e.nativeEvent as MouseEvent;
      if (me.button === 2) return false;
      const target = me.target as HTMLElement;
      if (target.closest('button, a, input, [data-role="ui"], [contenteditable]')) return false;

      // Accept clicks outside canvas — onStart will clamp to canvas edge.
      // This allows starting a lasso selection from the canvas border
      // (Photoshop-style edge-aligned selection workflow).
      return true;
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

      // ── Snap-to-start: dynamic threshold (constant screen px regardless of zoom) ──
      // Mirrors the pattern from core/geometry/operators/snapping.ts:
      //   dynamicThreshold = screenThreshold / cameraScale
      const start = trail[0];
      if (trail.length >= 8 && start) {
        const startScreen = e.geometry.space.localToScreen(start.x, start.y, e.activeFrame);
        const curScreen = e.geometry.space.localToScreen(clampedX, clampedY, e.activeFrame);
        const screenDist = Math.hypot(curScreen.x - startScreen.x, curScreen.y - startScreen.y);

        if (screenDist < SNAP_TO_START_SCREEN_PX) {
          // Snap: don't append the wobbly point, just show closed preview
          snappedToStart = true;
          if (lassoPreviewPathRef.current) {
            lassoPreviewPathRef.current.setAttribute('d', buildScreenPathD(trail, e) + ' Z');
          }
          return;
        }
      }

      // Not snapped — reset flag and append normally
      snappedToStart = false;
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

        // Static click (no meaningful drag) = clear selection (Photoshop behavior).
        // Unified with clipbox: single click dismisses, no double-click needed.
        if (trail.length < 3) {
          e.actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);
          return;
        }

        // ── Snap-to-start spike trim ──
        // If the user released while snapped to start, trim trailing points
        // that wandered into the snap radius. This removes the V-shaped spike
        // that forms when the cursor oscillates near the start point.
        if (snappedToStart && trail.length > 3) {
          const start = trail[0];
          // Use canvas-local distance with a generous radius (dynamic threshold
          // converted to local space). We trim from the end while points are
          // within 2× the snap threshold in local coords.
          const cameraScale = e.activeFrame.camera?.k || 1;
          const localThreshold = (SNAP_TO_START_SCREEN_PX * 2) / cameraScale;
          while (trail.length > 3) {
            const last = trail[trail.length - 1];
            const dist = Math.hypot(last.x - start.x, last.y - start.y);
            if (dist < localThreshold) {
              trail.pop();
            } else {
              break;
            }
          }
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
        lassoTrace('onEnd  ', 'trail=', trail.length, 'committed=', committed, 'snapped=', snappedToStart);
        trail = [];
        active = false;
        gestureAA = true;
        snappedToStart = false;
        clearPreview();
      }
    },
  };
};
