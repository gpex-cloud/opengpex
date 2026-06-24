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
  Layer,
  asLocalPoint,
  asLocalRect,
  asLocalPolygon,
} from '@opengpex/editor/core/types';
import { computePolygonBounds } from '@opengpex/editor/core/geometry/operators/polygon';
import { imageCache } from '@opengpex/editor/core/engine/cache/ImageCache';
import { magicWandClient } from './wand/client';
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
    // ─── Mode admission ────────────────────────────────────────────────
    // Re-Canvas operates as a *fully orthogonal* modal on top of pan
    // (2026-06-23 rework). When it's active the user expects the canvas
    // rect to be draggable & resizable just like in clip mode, so we must
    // admit pointer events even though `interactionMode === 'pan'`. But
    // *only* for the `clipbox` handlerKind — lasso / wand are strictly
    // clip-mode concerns (Re-Canvas is rectangular-only by definition).
    const inClip = e.state.interaction.interactionMode === 'clip';
    const inReCanvas = !!e.state.getStateSignal(CLIP_OPTIONS_SIGNAL_RE_CANVAS);
    if (!inClip && !(inReCanvas && targetKind === 'clipbox')) return false;

    // ─── Tool admission ────────────────────────────────────────────────
    // During Re-Canvas, regardless of the user's *previously selected*
    // clip tool (could be lasso / wand / ellipse), we want the rect
    // clipbox handler to dispatch — so synthesize `'rect'` as the active
    // tool here. This mirrors the synthesis done in `ClipOverlay/hooks.ts`
    // for the rendering side.
    const rawTool = e.state.getStateSignal<CropTool>(CLIP_OPTIONS_SIGNAL_CROP_TOOL, 'rect');
    const effectiveTool: CropTool = inReCanvas ? 'rect' : rawTool;
    return CROP_TOOL_STRATEGIES[effectiveTool].handlerKind === targetKind;
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
        clamp: !isReCanvas,
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
      const clampedX = Math.max(0, Math.min(e.point.canvas.x, e.activeFrame.canvas.w));
      const clampedY = Math.max(0, Math.min(e.point.canvas.y, e.activeFrame.canvas.h));
      trail = [asLocalPoint({ x: clampedX, y: clampedY })];
      // Initialize preview to a single moveTo so the path element is non-empty.
      if (lassoPreviewPathRef.current) {
        const sp = e.geometry.space.localToScreen(clampedX, clampedY, e.activeFrame);
        lassoPreviewPathRef.current.setAttribute('d', `M ${sp.x} ${sp.y}`);
      }
      lassoTrace('onStart', 'trail=', trail.length, 'previewRef=', !!lassoPreviewPathRef.current);
    },

    onMove: (e) => {
      if (!active) return;
      const clampedX = Math.max(0, Math.min(e.point.canvas.x, e.activeFrame.canvas.w));
      const clampedY = Math.max(0, Math.min(e.point.canvas.y, e.activeFrame.canvas.h));
      const p = asLocalPoint({ x: clampedX, y: clampedY });
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
        // Pre-PR-6-2: write irregularCropBoxes['lasso'] directly, symmetric
        // with how rect/ellipse handlers write imageCropBox. The dispatcher
        // provides a history checkpoint via the standard reducer pipeline, so
        // undo still captures this gesture as a single atom. Per-tool slot
        // ensures switching to wand never clobbers the lasso polygon (and
        // vice-versa); the visual gate then naturally hides this slot when
        // the active cropTool is something other than lasso.
        e.actions.setIrregularCropBox(e.activeFrame.id, 'lasso', polygon);
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
 * Wand defaults — Phase 1 hard-codes both. Phase 2 will surface a
 * `Tolerance` ComboInput on ClipOptions (signal `SIGNAL_WAND_TOLERANCE`) and
 * potentially toggle "Contiguous" via Shift modifier (Photoshop convention).
 */
const WAND_TOLERANCE_DEFAULT = 32;
const WAND_TIMEOUT_MS = 5_000;

/**
 * Douglas-Peucker simplification coefficient — controls how aggressively the
 * Worker prunes contour vertices (smaller = preserves more detail = bigger ring).
 *
 * Effective epsilon used by the Worker is `WAND_SIMPLIFY_COEF / scale` where
 * `scale` is the current viewport zoom (layer-pixels per screen-pixel⁻¹).
 * The division means: zoom in (scale > 1) → epsilon shrinks → finer detail
 * preserved; zoom out (scale < 1) → epsilon grows → aggressive collapse,
 * so the on-screen polygon stays at roughly constant visual fidelity.
 *
 *   Coefficient   Visual character                      4K full-image cost
 *   ------------  ------------------------------------  ----------------------
 *   0.5           Sub-pixel smooth, ~30% extra verts   ~250 verts typical
 *   1.0 (spec)    Pixel-equivalent — spec §6.5 default ~150 verts typical
 *   2.0           Slightly faceted, faster downstream  ~80 verts typical
 *
 * Phase 1 keeps this at 1.0 (strict spec §6.5 alignment). Phase 2 may surface
 * as a "Quality" slider in ClipOptions if user feedback demands.
 *
 * `WAND_SIMPLIFY_FLOOR` clamps the lower bound on extreme zoom-out (e.g.
 * scale=0.01 would otherwise yield epsilon=100 and over-collapse the polygon
 * into a near-triangle). 5 layer-pixels is the empirical sweet spot.
 */
const WAND_SIMPLIFY_COEF = 1.0;
const WAND_SIMPLIFY_FLOOR = 5;


/**
 * Pick the target raster layer under a wand click.
 *
 * Resolution order (matches selection-error UX expectations of common
 * editors):
 *   1. Top-most layer hit by the click point (regardless of activeLayerId).
 *      This lets users wand-click anywhere — they don't have to first
 *      activate the layer.
 *   2. activeLayer fallback when the click is over a transparent area / no
 *      layer is hit.
 *   3. Otherwise null → caller surfaces selectionErrorPulse.
 */
function pickWandTargetLayer(e: InteractionEvent): Layer | null {
  const top = e.geometry.space.pickTopLayer(e.point.world, e.activeFrame.layers);
  if (top) return top;
  const activeId = e.activeFrame.activeLayerId;
  if (activeId) {
    const lay = e.activeFrame.layers.byId[activeId];
    if (lay) return lay;
  }
  return null;
}

/**
 * Wand currently only supports raster image layers (`type: 'image'`).
 *
 * Phase 1 deliberately matches spec §6.5 strictly: `paint` (active brush
 * stroke buffer), `text`, vector / fill-color layers are all rejected.
 *   - `paint` is intentionally excluded even though it has pixel data: the
 *     buffer is mid-stroke / mutable, and wanding while a brush stroke is
 *     un-committed produces UX-confusing results. Phase 2 may relax this
 *     once `paint` layers are committed-only.
 *   - non-raster types have no `bounding`-sized RGBA buffer to flood.
 *
 * Caller surfaces selectionErrorPulse when this returns false.
 */
function isWandableLayer(layer: Layer): boolean {
  return layer.type === 'image';
}

/**
 * Decode the layer's source URL into a Uint8ClampedArray of layer-local pixels.
 *
 * We reuse the editor's global `imageCache`:
 *   - synchronous hit on hot path (image already decoded for stage rendering);
 *   - async fallback (`getOrFetch` returns undefined and starts a Promise) is
 *     awaited via cache.subscribe → next-tick retry. For Phase 1 we keep it
 *     simple: fall back to `new Image()` direct load when the cache misses.
 *
 * The resulting buffer is sized to `layer.bounding.w × .bounding.h` — i.e. the
 * layer's intrinsic raster dimensions in layer-local space, NOT the displayed
 * size after pose transforms. The wand worker speaks pure pixel-space.
 */
async function getLayerImageData(layer: Layer): Promise<ImageData> {
  // Try cache first — hot path.
  let img = imageCache.get(layer.src);
  if (!img) {
    // Cold load: bypass the cache's notify-once subscribe loop and just load
    // directly. We let the cache's own getOrFetch run in parallel for the
    // benefit of subsequent renders.
    imageCache.getOrFetch(layer.src);
    img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = 'anonymous';
      el.onload = () => resolve(el);
      el.onerror = (ev) => reject(new Error(`Failed to load layer image: ${typeof ev === 'string' ? ev : 'image error'}`));
      el.src = layer.src;
    });
  }

  const w = layer.bounding.w | 0;
  const h = layer.bounding.h | 0;
  if (w <= 0 || h <= 0) {
    throw new Error(`Layer has zero intrinsic dimensions (${w}×${h})`);
  }

  // Use OffscreenCanvas when available (avoids polluting the DOM); fall back
  // to a detached <canvas> element. Both produce identical RGBA8 buffers.
  let imageData: ImageData;
  if (typeof OffscreenCanvas !== 'undefined') {
    const off = new OffscreenCanvas(w, h);
    const ctx = off.getContext('2d');
    if (!ctx) throw new Error('Failed to acquire 2D context (OffscreenCanvas)');
    ctx.drawImage(img, 0, 0, w, h);
    imageData = ctx.getImageData(0, 0, w, h);
  } else {
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('Failed to acquire 2D context (HTMLCanvas)');
    ctx.drawImage(img, 0, 0, w, h);
    imageData = ctx.getImageData(0, 0, w, h);
  }

  return imageData;
}

/**
 * createWandHandler — magic-wand selection (PR-6 full implementation)
 *
 * Pipeline on pointerup:
 *   1. Pick target raster layer under the click (`pickWandTargetLayer`).
 *   2. Read layer-local ImageData (`getLayerImageData`).
 *   3. Project click point frame-local → world → layer-local (integer pixel).
 *   4. Hand off to `magicWandClient` (Worker: BFS flood + boundary trace +
 *      Douglas–Peucker; see `wand/wand.worker.ts`). The pixel buffer is sent
 *      via Transferable so a 4K image is zero-copy.
 *   5. Project Worker-produced layer-local rings → frame-local rings via the
 *      polygon engine (`layerLocalToFrameLocalPolygon`).
 *   6. Wrap as `LocalPolygon` and write `irregularCropBox` directly (Pre-PR-6-2
 *      symmetry with rect/ellipse — no `adv.irregular.selection.set` wrapper).
 *
 * Failure handling: every recoverable failure (transparent click /
 * non-raster layer / Worker timeout / decode error / empty rings) ends with
 * `selectionErrorPulse` plus a console.warn. We do NOT toast within the
 * handler — Phase 1 keeps the surface minimal; Phase 2 may wire `actions.toast`
 * once that subsystem stabilizes.
 */
export const createWandHandler = (): InteractionHandler => {
  // Single in-flight guard: clicking again while a previous wand request is
  // still running is a no-op (we don't queue). The Worker timeout puts an
  // upper bound on lock duration.
  let busy = false;

  return {
    id: 'clip-wand',
    priority: 110,

    test: (e) => {
      if (!makeCropToolGuard('wand')(e)) return false;
      const me = e.nativeEvent as MouseEvent;
      if (me.button === 2) return false;

      const frame = e.activeFrame;
      return e.geometry.space.isPointInRect(e.point.canvas, {
        x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h,
      });
    },

    onStart: () => {
      // No-op: wand commits on pointerup. (Phase 2: change cursor to "busy"
      // here, restore in onEnd's finally.)
    },

    onMove: () => {
      // No-op: wand doesn't drag.
    },

    onEnd: async (e) => {
      if (busy) {
        e.actions.setInteraction({ selectionErrorPulse: Date.now() });
        return;
      }
      busy = true;

      try {
        // 1. Pick target layer.
        const layer = pickWandTargetLayer(e);
        if (!layer || !isWandableLayer(layer)) {
          console.warn('[Wand] No wandable raster layer at click point');
          e.actions.setInteraction({ selectionErrorPulse: Date.now() });
          return;
        }

        // 2. Read layer-local ImageData.
        let imageData: ImageData;
        try {
          imageData = await getLayerImageData(layer);
        } catch (err) {
          console.error('[Wand] Failed to read layer image data:', err);
          e.actions.setInteraction({ selectionErrorPulse: Date.now() });
          return;
        }

        // 3. Project click world-point → layer-local integer pixel.
        //    `getLayerWorldMatrix` (used internally by polygon ops) gives us
        //    the layer pose; for a single point we use Matrix3x3 directly.
        const layerWM = e.geometry.transform.getLayerWorldMatrix(layer);
        const layerInv = layerWM.inverse();
        const layerPt = layerInv.apply({ x: e.point.world.x, y: e.point.world.y });
        const seed = { x: Math.floor(layerPt.x), y: Math.floor(layerPt.y) };
        if (
          seed.x < 0 || seed.y < 0 ||
          seed.x >= imageData.width || seed.y >= imageData.height
        ) {
          console.warn('[Wand] Click maps outside layer bounds', { seed, layer: layer.id });
          e.actions.setInteraction({ selectionErrorPulse: Date.now() });
          return;
        }

        // 4. Run worker. simplifyEpsilon scales with zoom — see WAND_SIMPLIFY_COEF
        //    block comment at the top of this file for the full rationale.
        //    Default is spec §6.5 strict: epsilon = 1.0 / scale, floored at 5.
        const scale = e.geometry.getScale(e.activeFrame);
        const simplifyEpsilon = Math.max(WAND_SIMPLIFY_FLOOR, WAND_SIMPLIFY_COEF / scale);

        let resp;
        try {
          resp = await magicWandClient.run({
            imageData: {
              data: imageData.data.buffer,  // Transferable — main thread loses access after this call
              width: imageData.width,
              height: imageData.height,
            },
            seed,
            tolerance: WAND_TOLERANCE_DEFAULT,
            simplifyEpsilon,
            contiguous: true,
          }, { timeoutMs: WAND_TIMEOUT_MS });
        } catch (err) {
          console.error('[Wand] Worker invocation failed:', err);
          e.actions.setInteraction({ selectionErrorPulse: Date.now() });
          return;
        }

        if (!resp.rings.length) {
          console.warn('[Wand] Worker returned empty selection');
          e.actions.setInteraction({ selectionErrorPulse: Date.now() });
          return;
        }

        // 5. Project layer-local rings → frame-local. We construct a
        //    minimal LocalPolygon in layer-space and let the polygon engine
        //    walk the rings.
        const layerRings = resp.rings.map(ring => ring.map(p => asLocalPoint({ x: p.x, y: p.y })));
        const layerBounds = asLocalRect(computePolygonBounds(layerRings));
        const layerPoly = asLocalPolygon(layerRings, layerBounds);
        const framePoly = e.geometry.polygon.layerLocalToFrameLocalPolygon(
          layerPoly, layer, e.activeFrame
        );

        // 6. Commit to the wand-specific slot in `irregularCropBoxes`.
        //    Symmetric with lasso — direct action dispatch, no adv wrapper
        //    command. The dispatcher's standard reducer pipeline establishes a
        //    history checkpoint. Per-tool slot ensures switching to lasso
        //    never clobbers the wand polygon (and vice-versa).
        e.actions.setIrregularCropBox(e.activeFrame.id, 'wand', framePoly);


        if (resp.debug) {
          console.info('[Wand] selected',
            { layer: layer.id, seed, ...resp.debug, rings: resp.rings.length });
        }
      } finally {
        busy = false;
      }
    },
  };
};
