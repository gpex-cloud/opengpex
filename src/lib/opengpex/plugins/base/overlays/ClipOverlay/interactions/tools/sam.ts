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
import { sourceBitmapCache } from '@opengpex/editor/core/engine/cache/SourceBitmapCache';
import { ClipOptionsAPI } from '../../../../options/ClipOptions/protocols';
import {
  AIToolsDrawerAPI,
  type SegPrompt,
  type SegEncodePayload,
  type SegEncodeResult,
  type SegDecodePayload,
  type SegDecodeResult,
} from '../../../../drawers/AIToolsDrawer/protocols';
import { makeClipToolGuard } from '../guard';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Minimum drag distance (px) to trigger box prompt instead of point prompt. */
const BOX_DRAG_THRESHOLD = 8;

// ─── Internal Helpers ──────────────────────────────────────────────────────────

/**
 * Pick the target raster layer under the click.
 * Same resolution logic as wand: top-most hit → activeLayer fallback.
 */
function pickSamTargetLayer(e: InteractionEvent): Layer | null {
  const top = e.geometry.space.pickTopLayer(e.point.world, e.activeFrame.layers);
  if (top) return top;
  const activeId = e.activeFrame.activeLayerId;
  if (activeId) {
    const lay = e.activeFrame.layers.byId[activeId];
    if (lay) return lay;
  }
  return null;
}

function isSamableLayer(layer: Layer): boolean {
  return layer.type === 'image';
}

/**
 * Decode layer source into RGBA pixel buffer for embedding.
 */
async function getLayerImageData(layer: Layer): Promise<ImageData> {
  let img: ImageBitmap | undefined = sourceBitmapCache.get(layer.src);
  if (!img) {
    sourceBitmapCache.getOrFetch(layer.src);
    img = await new Promise<ImageBitmap>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsub();
        reject(new Error(`Failed to load layer image: ${layer.src} (timeout)`));
      }, 15_000);
      const unsub = sourceBitmapCache.subscribe(() => {
        const bmp = sourceBitmapCache.get(layer.src);
        if (bmp) {
          clearTimeout(timeout);
          unsub();
          resolve(bmp);
        }
      });
      const bmp = sourceBitmapCache.get(layer.src);
      if (bmp) {
        clearTimeout(timeout);
        unsub();
        resolve(bmp);
      }
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
 * createSamHandler — AI segmentation (SAM 2.1) selection
 *
 * Pipeline on pointerup:
 *   1. Pick target raster layer under the click.
 *   2. Ensure embedding via AIToolsDrawer's segEncode command (cached if same layer).
 *   3. Build prompt: point (single click) or box (drag).
 *   4. Call AIToolsDrawer's segDecode command → get polygon rings.
 *   5. Project layer-local rings → frame-local, write to clipBoxes['sam'].
 *
 * Decoupling: This handler communicates with the SAM Worker exclusively through
 * the AIToolsDrawerAPI facade commands (segEncode / segDecode). It does NOT
 * import any internal Worker modules, ensuring ClipOverlay and AIToolsDrawer
 * remain independently deployable plugins.
 */
export const createSamHandler = (): InteractionHandler => {
  let busy = false;
  let discardPending = false;
  let startWorld: { x: number; y: number } | null = null;

  return {
    id: 'clip-sam',
    priority: 110,

    test: (e) => {
      if (!makeClipToolGuard('sam')(e)) return false;
      const me = e.nativeEvent as MouseEvent;
      if (me.button === 2) return false;
      const target = me.target as HTMLElement;
      if (target.closest('button, a, input, [data-role="ui"], [contenteditable]')) return false;
      return true;
    },

    onStart: (e) => {
      startWorld = { x: e.point.world.x, y: e.point.world.y };
    },

    onMove: () => {
      // Future: render box preview overlay during drag.
    },

    onEnd: async (e) => {
      const endWorld = { x: e.point.world.x, y: e.point.world.y };

      // Single-click outside canvas = clear selection.
      const frame = e.activeFrame;
      const isOutsideCanvas = !e.geometry.space.isPointInRect(e.point.canvas, {
        x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h,
      });
      if (isOutsideCanvas) {
        discardPending = true;
        e.actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);
        startWorld = null;
        return;
      }

      if (busy) {
        e.actions.setInteraction({ selectionErrorPulse: Date.now() });
        startWorld = null;
        return;
      }
      busy = true;
      discardPending = false;

      try {
        // 1. Pick target layer.
        const layer = pickSamTargetLayer(e);
        if (!layer || !isSamableLayer(layer)) {
          console.warn('[SAM] No target raster layer at click point');
          e.actions.setInteraction({ selectionErrorPulse: Date.now() });
          return;
        }

        // 2. Ensure embedding is ready via AIToolsDrawer command.
        const assetId = layer.src; // Use src URL as unique asset key
        let imageData: ImageData;
        try {
          imageData = await getLayerImageData(layer);
        } catch (_err) {
          e.actions.setInteraction({ selectionErrorPulse: Date.now() });
          return;
        }

        const encodePayload: SegEncodePayload = {
          imageData: {
            data: imageData.data.buffer,
            width: imageData.width,
            height: imageData.height,
          },
          context: {
            frameId: frame.id,
            layerId: layer.id,
            assetId,
          },
        };

        const encodeResult = e.actions.executeCommand<SegEncodePayload, Promise<SegEncodeResult>>(
          AIToolsDrawerAPI.commands.segEncode.uid,
          encodePayload,
        );

        // executeCommand returns the result synchronously (the Promise itself)
        const encResult = await encodeResult;
        if (!encResult || !encResult.success) {
          e.actions.setInteraction({ selectionErrorPulse: Date.now() });
          return;
        }

        if (discardPending) return;

        // 3. Build prompt: point or box.
        const layerWM = e.geometry.transform.getLayerWorldMatrix(layer);
        const layerInv = layerWM.inverse();

        const prompts: SegPrompt[] = [];
        const dragDist = startWorld
          ? Math.hypot(endWorld.x - startWorld.x, endWorld.y - startWorld.y)
          : 0;

        if (startWorld && dragDist >= BOX_DRAG_THRESHOLD) {
          // Box prompt
          const p1 = layerInv.apply(startWorld);
          const p2 = layerInv.apply(endWorld);
          prompts.push({
            type: 'box',
            x1: Math.min(p1.x, p2.x),
            y1: Math.min(p1.y, p2.y),
            x2: Math.max(p1.x, p2.x),
            y2: Math.max(p1.y, p2.y),
          });
        } else {
          // Point prompt (foreground click)
          const layerPt = layerInv.apply(endWorld);
          prompts.push({
            type: 'point',
            x: layerPt.x,
            y: layerPt.y,
            label: 1, // foreground
          });
        }

        // 4. Decode via AIToolsDrawer command.
        const decodePayload: SegDecodePayload = {
          prompts,
          context: {
            frameId: frame.id,
            layerId: layer.id,
            assetId,
          },
        };

        const decodeResult = e.actions.executeCommand<SegDecodePayload, Promise<SegDecodeResult>>(
          AIToolsDrawerAPI.commands.segDecode.uid,
          decodePayload,
        );

        const decResult = await decodeResult;
        if (!decResult || !decResult.success) {
          e.actions.setInteraction({ selectionErrorPulse: Date.now() });
          return;
        }

        if (!decResult.masks || decResult.masks.length === 0 || decResult.masks[0].rings.length === 0) {
          console.warn('[SAM] Decoder returned empty mask');
          e.actions.setInteraction({ selectionErrorPulse: Date.now() });
          return;
        }

        if (discardPending) return;

        // 5. Project ALL candidate masks to frame-local polygons.
        //    Store them in the signal so the panel can switch between them.
        const clipBox = getClipBox(e.activeFrame);
        const samAA = clipBox?.antiAliased ?? true;

        const framePolygons: Array<ReturnType<typeof asLocalPolygon>> = [];
        for (const mask of decResult.masks) {
          if (mask.rings.length === 0) continue;
          const layerRings = mask.rings.map(ring =>
            ring.map(p => asLocalPoint({ x: p.x, y: p.y }))
          );
          const layerBounds = asLocalRect(e.geometry.polygon.computePolygonBounds(layerRings));
          const layerPoly = asLocalPolygon(layerRings, layerBounds, samAA);
          const framePoly = e.geometry.polygon.layerLocalToFrameLocal(
            layerPoly, layer, e.activeFrame
          );
          framePolygons.push(framePoly);
        }

        if (framePolygons.length === 0) {
          console.warn('[SAM] All masks projected to empty polygons');
          e.actions.setInteraction({ selectionErrorPulse: Date.now() });
          return;
        }

        // Store frame-projected polygons in the seg status signal for panel switching.
        // Include all state fields to avoid issues if setStateSignal replaces vs merges.
        e.actions.setStateSignal(
          AIToolsDrawerAPI.signals.segStatus,
          {
            stage: 'ready',
            embeddingReady: true,
            candidates: decResult.masks,
            candidateFramePolygons: framePolygons,
            samFrameId: e.activeFrame.id,
            activeCandidateIdx: 0,
            lastDecodeMs: decResult.debug?.decodeMs ?? 0,
            elapsedMs: decResult.debug?.totalMs ?? 0,
          },
        );

        // 6. Commit best mask to sam clip slot.
        e.actions.setClipBox(e.activeFrame.id, 'sam', framePolygons[0]);

        if (decResult.debug) {
          console.info('[SAM] selected', {
            layer: layer.id,
            score: decResult.masks[0].score.toFixed(3),
            ...decResult.debug,
          });
        }
      } finally {
        busy = false;
        startWorld = null;
      }
    },
  };
};
