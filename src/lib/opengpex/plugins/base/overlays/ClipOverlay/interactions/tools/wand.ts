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
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { createAsyncHandler } from '../../../../../../stage/interaction/handlers/AsyncHandler';
import { magicWandClient } from '../../workers/client';
import { ClipOptionsAPI } from '../../../../options/ClipOptions/protocols';
import { makeClipToolGuard } from '../guard';

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
  return createAsyncHandler({
    id: 'clip-wand',
    priority: 110,

    test: (e) => {
      if (!makeClipToolGuard('wand')(e)) return false;
      const me = e.nativeEvent as MouseEvent;
      const target = me.target as HTMLElement;
      if (target.closest('button, a, input, [data-role="ui"], [contenteditable]')) return false;

      // Accept clicks outside canvas — execute will clear selection for
      // outside-canvas clicks (unified single-click dismiss behavior).
      return true;
    },

    onBusy: (e) => {
      e.actions.setInteraction({ selectionErrorPulse: Date.now() });
    },

    execute: async (e, ctx) => {
      // Single-click outside canvas = clear selection (Photoshop behavior).
      // Unified with clipbox/lasso: clicking outside the canvas dismisses.
      const frame = e.activeFrame;
      const isOutsideCanvas = !e.geometry.space.isPointInRect(e.point.canvas, {
        x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h,
      });
      if (isOutsideCanvas) {
        e.actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);
        return;
      }

      // 1. Pick target layer.
      const layer = pickWandTargetLayer(e);
      if (!layer || !isWandableLayer(layer)) {
        e.actions.setInteraction({ selectionErrorPulse: Date.now() });
        return;
      }

      // 2. Read layer-local ImageData (by content hash — WorkerCache key).
      let imageData: ImageData;
      try {
        imageData = await e.pixels.image.imageData(layer.assetId!);
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
        e.actions.setInteraction({ selectionErrorPulse: Date.now() });
        return;
      }

      // If cancelled while worker was running, discard result.
      if (ctx.isDiscarded()) return;

      // 5. Project layer-local rings → frame-local.
      const clipBox = getClipBox(e.activeFrame);
      const wandAA = clipBox?.antiAliased ?? true;

      const layerRings = resp.rings.map(ring => ring.map(p => asLocalPoint({ x: p.x, y: p.y })));
      const layerBounds = asLocalRect(e.geometry.polygon.computePolygonBounds(layerRings));
      const layerPoly = asLocalPolygon(layerRings, layerBounds, wandAA);
      const framePoly = e.geometry.polygon.layerLocalToFrameLocal(
        layerPoly, layer, e.activeFrame
      );

      // 6. Commit to wand slot.
      e.actions.setClipBox(e.activeFrame.id, 'wand', framePoly);
    },
  });
};
