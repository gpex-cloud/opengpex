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
  InteractionEvent,
  LocalPoint,
  asLocalPoint,
  asLocalRect,
  asLocalPolygon,
} from '@opengpex/editor/core/types';
import { computePolygonBounds } from '@opengpex/editor/core/geometry/operators/polygon';
import {
  CLIP_OPTIONS_SIGNAL_RE_CANVAS,
  CLIP_OPTIONS_SIGNAL_CROP_TOOL,
  CLIP_OPTIONS_CMD_RESET_BOX,
  CROP_TOOL_STRATEGIES,
  CropTool,
  CropToolStrategy,
} from '../../options/ClipOptions/protocols';
import { InteractionMath } from '@opengpex/editor/stage/interaction/Math';
import { createTransformHandler } from '@opengpex/editor/stage/interaction/handlers/TransformHandler';

/**
 * makeCropToolGuard — Pre-PR-6-2 strategy-driven handler dispatch helper.
 *
 * Returns `true` exactly when the editor is in clip mode AND the active
 * cropTool's `handlerKind` matches `targetKind`. Each handler in this file
 * uses one such guard at the head of its `test()` so that:
 *   1. all "is this my pointer event?" branching consults the same Strategy
 *      table (Single Source of Truth in `protocols.ts`);
 *   2. adding a new clip tool requires zero changes here — only adding a row
 *      to `CROP_TOOL_STRATEGIES` plus (optionally) a new handler factory.
 */
function makeCropToolGuard(targetKind: CropToolStrategy['handlerKind']) {
  return (e: InteractionEvent): boolean => {
    if (e.state.interaction.interactionMode !== 'clip') return false;
    const tool = e.state.getStateSignal<CropTool>(CLIP_OPTIONS_SIGNAL_CROP_TOOL, 'rect');
    return CROP_TOOL_STRATEGIES[tool].handlerKind === targetKind;
  };
}

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

/**
 * ClipBoxHandler: Core interaction handler for clip tool
 * Handles crop box: Resize, Move, Create, and Peel
 */
export const createClipBoxHandler = (): InteractionHandler => {
  let hasPeeled = false;

  return createTransformHandler({
    id: 'clip-box',
    priority: 100,

    test: (e) => {
      // Pre-PR-6-2: replace the previous mode + literal-tool-name check with a
      // strategy-driven guard. `clipbox` is the handlerKind owned by the rect /
      // ellipse-smooth / ellipse-pixel rows of `CROP_TOOL_STRATEGIES`; lasso /
      // wand rows declare a different handlerKind and are therefore excluded
      // automatically (no `tool === 'lasso' || tool === 'wand'` literal needed).
      if (!makeCropToolGuard('clipbox')(e)) return null;

      const target = e.nativeEvent.target as HTMLElement;

      const handleElement = target.closest('[data-handle]') as HTMLElement;
      if (handleElement) {
        const handle = handleElement.dataset.handle || 'move';
        // Meta+drag crop box -> enter peel mode (peel fragments)
        if (handle === 'move' && (e.nativeEvent as MouseEvent).metaKey) {
          return 'peel';
        }
        return handle;
      }

      if (target.closest('button, a, [data-role="ui"]')) return null;

      const frame = e.activeFrame;
      const isInsideCanvas = e.geometry.space.isPointInRect(e.point.canvas, {
        x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h
      });

      if (isInsideCanvas) return 'potential_create';

      return null;
    },

    getInitialState: (e) => {
      const isReCanvas = e.state.getStateSignal(CLIP_OPTIONS_SIGNAL_RE_CANVAS) || false;
      const currentShape = isReCanvas ? e.activeFrame.canvasCropBox : e.activeFrame.imageCropBox;
      hasPeeled = false;
      return currentShape.rect;
    },

    getConstraints: (e) => {
      const isReCanvas = e.state.getStateSignal(CLIP_OPTIONS_SIGNAL_RE_CANVAS) || false;
      return {
        aspect: isReCanvas ? e.activeFrame.canvasAspect : e.activeFrame.imageAspect,
        clamp: isReCanvas,
        alignToLayerId: isReCanvas ? undefined : e.activeFrame.activeLayerId || undefined
      };
    },

    onUpdate: (e, newRect, tx, { dx, dy, type }) => {
      const frame = e.activeFrame;
      const isReCanvas = e.state.getStateSignal(CLIP_OPTIONS_SIGNAL_RE_CANVAS) || false;
      const boxKey = isReCanvas ? 'canvasCropBox' : 'imageCropBox';
      const currentShape = isReCanvas ? frame.canvasCropBox : frame.imageCropBox;

      if (type === 'peel' && (e.nativeEvent as MouseEvent).metaKey) {
        if (!hasPeeled) {
          if (Math.sqrt(dx * dx + dy * dy) > 5) {
            hasPeeled = true;
            setTimeout(() => e.actions.adv.layer.peel.peelToExchange.execute({ isCopy: (e.nativeEvent as MouseEvent).altKey }), 0);
          }
          return;
        }
      }

      tx.update({ [boxKey]: { ...currentShape, rect: newRect } }, 'frame');

      // Sync exchange layer if needed
      if (!isReCanvas && frame.activeLayerId) {
        const activeLayer = frame.activeLayerId ? frame.layers.byId[frame.activeLayerId] : undefined;
        const exchangeLayer = (activeLayer?.role === 'exchange')
          ? activeLayer
          : frame.layers.order.map(id => frame.layers.byId[id]).find(l => l.role === 'exchange' && l.parentId === frame.activeLayerId);

        if (exchangeLayer) {
          tx.update({
            cx: newRect.x + newRect.w / 2 - frame.canvas.w / 2,
            cy: newRect.y + newRect.h / 2 - frame.canvas.h / 2
          }, 'layer', exchangeLayer.id);
        }
      }
    },

    onEnd: (e, tx, startCanvas) => {
      // Handle Double Click to reset
      if (InteractionMath.isDoubleClick(e, startCanvas)) {
        const isReCanvas = e.state.getStateSignal(CLIP_OPTIONS_SIGNAL_RE_CANVAS) || false;
        const currentShape = isReCanvas ? e.activeFrame.canvasCropBox : e.activeFrame.imageCropBox;

        const isInside = e.geometry.space.isPointInRect(e.point.canvas, currentShape.rect);
        if (isInside) {
          e.actions.executeCommand(CLIP_OPTIONS_CMD_RESET_BOX);
        }
      }

      tx.commit();
      hasPeeled = false;
    }
  });
};

// ─── createLassoHandler ────────────────────────────────────────────────────────

/**
 * Encode a frame-local LocalPoint trail into a screen-space SVG `d` attribute.
 * The lasso preview path lives at viewport (0, 0) (no group transform), so we
 * project frame-local → screen on every emit. This is a once-per-frame cost
 * and avoids any redux roundtrip.
 *
 * [Pre-PR-6] We deliberately do NOT append a trailing `Z` here: while the user
 * is still dragging, the polygon is unfinished and a closing segment would
 * spuriously connect the cursor back to the start point, giving a misleading
 * "loop already closed" appearance. The final committed polygon (in `onEnd`,
 * via `asLocalPolygon` + `polygonToSvgPathD`) is responsible for adding the
 * closing geometry exactly once.
 */
function buildScreenPathD(
  trail: LocalPoint[],
  e: { activeFrame: import('@opengpex/editor/core/types').Frame; geometry: import('@opengpex/editor/core/types').GeometryService }
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

// [Pre-PR-6 缺陷 B 诊断] Dev-only counter wired into the lasso lifecycle so
// the user can confirm in DevTools whether onStart / onMove / onEnd actually
// fire during a drag. Static code review for B's three candidate root causes
// (B1 hook-name typo, B2 missing cropTool guard, B3 wrong test() return type)
// found none of them present in the current code, so the runtime trace below
// is the safest way to localize the real cause without speculative rewrites.
//
// Output format (one line per pointer event):
//   [Lasso] onStart  trail=1
//   [Lasso] onMove   trail=2
//   [Lasso] onMove   trail=3
//   ...
//   [Lasso] onEnd    trail=42 committed=true
//
// If onMove never appears between onStart and onEnd, the dispatcher is not
// forwarding pointermove to this handler — which would then point to a
// different real cause than spec §Pre-PR-6.1's enumerated three.
const LASSO_TRACE = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';
function lassoTrace(...args: unknown[]) {
  if (LASSO_TRACE) console.info('[Lasso]', ...args);
}


function clearPreview() {
  if (lassoPreviewPathRef.current) {
    lassoPreviewPathRef.current.setAttribute('d', '');
  }
}

/**
 * createLassoHandler — free-form polygon selection
 *
 * Lifecycle:
 *   onStart     start trail with first frame-local point + clear preview
 *   onMove      append point, repaint preview path d (screen space, no redux)
 *   onEnd       (≥3 points) → compute bounds → asLocalPolygon → adv.irregular.selection.set
 *               always clear preview + reset trail
 *
 * The handler is a plain InteractionHandler (NOT createTransformHandler) because a
 * lasso trail is not a rect transformation. Pattern source:
 *   - BrushOverlay/interactions.ts (offscreen canvas, commit on end)
 */
export const createLassoHandler = (): InteractionHandler => {
  let trail: LocalPoint[] = [];
  let active = false;

  return {
    id: 'clip-lasso',
    priority: 110,

    test: (e) => {
      // Pre-PR-6-2: strategy-driven dispatch — only fires when the active tool
      // declares `handlerKind: 'lasso'` (currently the lasso row only).
      if (!makeCropToolGuard('lasso')(e)) return false;

      // Right-click and UI elements are off-limits
      const me = e.nativeEvent as MouseEvent;
      if (me.button === 2) return false;
      const target = me.target as HTMLElement;
      if (target.closest('button, a, input, [data-role="ui"], [contenteditable]')) return false;

      // Active anywhere over the canvas; outside-canvas pointerdown should not start a lasso
      const frame = e.activeFrame;
      return e.geometry.space.isPointInRect(e.point.canvas, {
        x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h,
      });
    },

    onStart: (e) => {
      active = true;
      trail = [asLocalPoint({ x: e.point.canvas.x, y: e.point.canvas.y })];
      // Initialize preview to a single moveTo so the path element is non-empty.
      if (lassoPreviewPathRef.current) {
        const sp = e.geometry.space.localToScreen(e.point.canvas.x, e.point.canvas.y, e.activeFrame);
        lassoPreviewPathRef.current.setAttribute('d', `M ${sp.x} ${sp.y}`);
      }
      lassoTrace('onStart', 'trail=', trail.length, 'previewRef=', !!lassoPreviewPathRef.current);
    },

    onMove: (e) => {
      if (!active) return;
      const p = asLocalPoint({ x: e.point.canvas.x, y: e.point.canvas.y });
      trail.push(p);
      if (lassoPreviewPathRef.current) {
        lassoPreviewPathRef.current.setAttribute('d', buildScreenPathD(trail, e));
      }
      // [Pre-PR-6 缺陷 B 诊断] Throttled trace (every 5th sample to avoid log
      // spam) — proves whether the dispatcher is forwarding pointermove.
      if (trail.length % 5 === 0) {
        lassoTrace('onMove', 'trail=', trail.length);
      }
    },

    onEnd: (e) => {
      let committed = false;
      try {
        if (!active) return;
        if (trail.length < 3) return; // noise-suppression: too short to form a polygon

        const ring = trail.slice(); // evenodd renderer + path Z auto-closes the contour
        const bounds = computePolygonBounds([ring]);
        const polygon = asLocalPolygon([ring], asLocalRect(bounds));
        // Pre-PR-6-2: write irregularCropBox directly, symmetric with how
        // rect/ellipse handlers write imageCropBox. The dispatcher provides a
        // history checkpoint via the standard reducer pipeline, so undo still
        // captures this gesture as a single atom.
        e.actions.setIrregularCropBox(e.activeFrame.id, polygon);
        committed = true;
      } finally {
        lassoTrace('onEnd  ', 'trail=', trail.length, 'committed=', committed);
        trail = [];
        active = false;
        clearPreview();
      }
    },
  };
};

// ─── createWandHandler ─────────────────────────────────────────────────────────

/**
 * createWandHandler — magic-wand selection (skeleton only)
 *
 * Phase 1 ships only the handler scaffold and the cropTool guard wiring; the
 * full implementation (BFS flood-fill + Marching Squares + Douglas-Peucker
 * simplification, all in a Web Worker) lands in PR-6 — see
 * `phase1_irregular_clip_spec.md` §3.3.7 + §6.
 *
 * Until then, the handler:
 *   1. correctly claims the pointer chain (so the rect ClipBoxHandler does NOT fire),
 *   2. fires `selectionErrorPulse` on pointerup to give the user immediate UI feedback
 *      that the tool is selected but not yet implemented.
 */
export const createWandHandler = (): InteractionHandler => ({
  id: 'clip-wand',
  priority: 110,

  test: (e) => {
    // Pre-PR-6-2: strategy-driven dispatch — only fires when the active tool
    // declares `handlerKind: 'wand'` (currently the wand row only).
    if (!makeCropToolGuard('wand')(e)) return false;
    const me = e.nativeEvent as MouseEvent;
    if (me.button === 2) return false;

    const frame = e.activeFrame;
    return e.geometry.space.isPointInRect(e.point.canvas, {
      x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h,
    });
  },

  onStart: () => {
    // No-op: wand commits on pointerup (single-click sample). Reserved hook for
    // PR-6 to start a "sampling…" cursor / busy indicator.
  },

  onMove: () => {
    // No-op: wand doesn't drag.
  },

  onEnd: (e) => {
    // PR-6 will: (1) hit-test the topmost layer under the click, (2) postMessage
    // the layer ImageData to MagicWandWorker with seed + tolerance, (3) receive
    // layer-local rings, (4) project into frame-local, (5) commit via
    // adv.irregular.selection.set. For now: surface a "not yet implemented"
    // pulse that uses the existing selection-error UI.
    if (typeof console !== 'undefined') {
      console.info('[ClipOverlay] Magic Wand picked at canvas point', e.point.canvas, '(implementation deferred to PR-6)');
    }
    e.actions.setInteraction({ selectionErrorPulse: Date.now() });
  },
});
