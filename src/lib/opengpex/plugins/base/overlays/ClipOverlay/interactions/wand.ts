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
  Layer,
  asLocalPoint,
  asLocalRect,
  asLocalPolygon,
} from '@opengpex/editor/core/types';
import { computePolygonBounds } from '@opengpex/editor/core/geometry/operators/polygon';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { imageCache } from '@opengpex/editor/core/engine/cache/ImageCache';
import { magicWandClient } from '../wand/client';
import { ClipOptionsAPI } from '../../../options/ClipOptions/protocols';
import { makeCropToolGuard } from './guard';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Phase 1 hard-codes tolerance. Phase 2 will surface a ComboInput signal. */
const WAND_TOLERANCE_DEFAULT = 32;
const WAND_TIMEOUT_MS = 5_000;

/**
 * Douglas-Peucker simplification coefficient — controls how aggressively the
 * Worker prunes contour vertices (smaller = preserves more detail = bigger ring).
 *
 * Effective epsilon used by the Worker is `WAND_SIMPLIFY_COEF / scale` where
 * `scale` is the current viewport zoom. The division means: zoom in → finer
 * detail preserved; zoom out → aggressive collapse.
 */
const WAND_SIMPLIFY_COEF = 0.8;
const WAND_SIMPLIFY_FLOOR = 1.5;

// ─── Internal Helpers ──────────────────────────────────────────────────────────

/**
 * Pick the target raster layer under a wand click.
 *
 * Resolution order:
 *   1. Top-most layer hit by the click point.
 *   2. activeLayer fallback when click is over transparent area.
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
 */
function isWandableLayer(layer: Layer): boolean {
  return layer.type === 'image';
}

/**
 * Decode the layer's source URL into a Uint8ClampedArray of layer-local pixels.
 * Reuses the editor's global `imageCache` for synchronous hits on hot path.
 */
async function getLayerImageData(layer: Layer): Promise<ImageData> {
  let img = imageCache.get(layer.src);
  if (!img) {
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

// ─── Handler ───────────────────────────────────────────────────────────────────

/**
 * createWandHandler — magic-wand selection
 *
 * Pipeline on pointerup:
 *   1. Pick target raster layer under the click.
 *   2. Read layer-local ImageData.
 *   3. Project click point frame-local → world → layer-local (integer pixel).
 *   4. Hand off to `magicWandClient` (Worker: BFS flood + boundary trace +
 *      Douglas–Peucker).
 *   5. Project Worker-produced layer-local rings → frame-local rings.
 *   6. Wrap as `LocalPolygon` and write clip slot.
 */
export const createWandHandler = (): InteractionHandler => {
  let busy = false;
  let discardPending = false;

  return {
    id: 'clip-wand',
    priority: 110,

    test: (e) => {
      if (!makeCropToolGuard('wand')(e)) return false;
      const me = e.nativeEvent as MouseEvent;
      if (me.button === 2) return false;
      const target = me.target as HTMLElement;
      if (target.closest('button, a, input, [data-role="ui"], [contenteditable]')) return false;

      // Accept clicks outside canvas — onEnd will clear selection for
      // outside-canvas clicks (unified single-click dismiss behavior).
      return true;
    },

    onStart: () => {
      // No-op: wand commits on pointerup.
    },

    onMove: () => {
      // No-op: wand doesn't drag.
    },

    onEnd: async (e) => {
      // Single-click outside canvas = clear selection (Photoshop behavior).
      // Unified with clipbox/lasso: clicking outside the canvas dismisses.
      const frame = e.activeFrame;
      const isOutsideCanvas = !e.geometry.space.isPointInRect(e.point.canvas, {
        x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h,
      });
      if (isOutsideCanvas) {
        discardPending = true;
        e.actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);
        return;
      }

      if (busy) {
        e.actions.setInteraction({ selectionErrorPulse: Date.now() });
        return;
      }
      busy = true;
      discardPending = false;

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

        // 4. Run worker.
        const scale = e.geometry.getScale(e.activeFrame);
        const simplifyEpsilon = Math.max(WAND_SIMPLIFY_FLOOR, WAND_SIMPLIFY_COEF / scale);

        let resp;
        try {
          resp = await magicWandClient.run({
            imageData: {
              data: imageData.data.buffer,
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

        // If double-click occurred while worker was running, discard result.
        if (discardPending) return;

        // 5. Project layer-local rings → frame-local.
        const clipBox = getClipBox(e.activeFrame);
        const wandAA = clipBox?.spatial.antiAliased ?? true;

        const layerRings = resp.rings.map(ring => ring.map(p => asLocalPoint({ x: p.x, y: p.y })));
        const layerBounds = asLocalRect(computePolygonBounds(layerRings));
        const layerPoly = asLocalPolygon(layerRings, layerBounds, wandAA);
        const framePoly = e.geometry.polygon.layerLocalToFrameLocal(
          layerPoly, layer, e.activeFrame
        );

        // 6. Commit to wand slot.
        e.actions.setClipBox(e.activeFrame.id, 'wand', framePoly);

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
