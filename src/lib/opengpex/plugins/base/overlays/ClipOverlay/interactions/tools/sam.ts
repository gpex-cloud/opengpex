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
import { ClipOptionsAPI } from '../../../../options/ClipOptions/protocols';
import { AIToolsDrawerAPI } from '../../../../drawers/AIToolsDrawer/protocols';
import { segStore } from '../../../../drawers/AIToolsDrawer/segmentation/store';
import type {
  SegPrompt,
  SegEncodePayload,
  SegEncodeResult,
  SegDecodePayload,
  SegDecodeResult,
} from '../../../../drawers/AIToolsDrawer/segmentation/protocols';
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
  let startWorld: { x: number; y: number } | null = null;

  return createAsyncHandler({
    id: 'clip-sam',
    priority: 110,

    test: (e) => {
      if (!makeClipToolGuard('sam')(e)) return false;
      const me = e.nativeEvent as MouseEvent;
      const target = me.target as HTMLElement;
      if (target.closest('button, a, input, [data-role="ui"], [contenteditable]')) return false;
      return true;
    },

    onStart: (e) => {
      startWorld = { x: e.point.world.x, y: e.point.world.y };
    },

    onBusy: (e) => {
      e.actions.setInteraction({ selectionErrorPulse: Date.now() });
    },

    onCancel: () => {
      startWorld = null;
    },

    execute: async (e, ctx) => {
      const endWorld = { x: e.point.world.x, y: e.point.world.y };

      // Single-click outside canvas = clear selection.
      const frame = e.activeFrame;
      const isOutsideCanvas = !e.geometry.space.isPointInRect(e.point.canvas, {
        x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h,
      });
      if (isOutsideCanvas) {
        e.actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);
        startWorld = null;
        return;
      }

      try {
        // 1. Pick target layer.
        const layer = pickSamTargetLayer(e);
        if (!layer || !isSamableLayer(layer)) {
          console.warn('[SAM] No target raster layer at click point');
          e.actions.setInteraction({ selectionErrorPulse: Date.now() });
          return;
        }

        // 2. Ensure embedding is ready via AIToolsDrawer command.
        const assetId = layer.assetId; // content hash — canonical asset identity
        let imageData: ImageData;
        try {
          imageData = await e.pixels.image.imageData(layer.assetId!);
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

        if (ctx.isDiscarded()) return;

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

        if (ctx.isDiscarded()) return;

        // 5. Project ALL candidate masks to frame-local polygons.
        //    Store them in the signal so the panel can switch between them.
        const clipBox = getClipBox(e.activeFrame);
        const samAA = clipBox?.antiAliased ?? true;

        const framePolygons: Array<ReturnType<typeof asLocalPolygon>> = [];
        for (const mask of decResult.masks) {
          if (mask.rings.length === 0) continue;
          // Round ONNX decoder output to integer pixel grid (matches wand/lasso behavior).
          const layerRings = mask.rings.map(ring =>
            ring.map(p => asLocalPoint({ x: Math.round(p.x), y: Math.round(p.y) }))
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

        // Store frame-projected polygons in the seg store for panel switching.
        segStore.setState({
          lastResult: {
            candidates: decResult.masks,
            candidateFramePolygons: framePolygons,
            samFrameId: e.activeFrame.id,
            activeCandidateIdx: 0,
            lastDecodeMs: decResult.debug?.decodeMs ?? 0,
          },
        });

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
        startWorld = null;
      }
    },
  });
};
