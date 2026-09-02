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

import { asLocalShape } from '@opengpex/editor/core/types';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { createToolCommand } from '../../_shared/control/createToolCommand';
import type { ProcessResultOutcome } from '../../_shared/control/createToolCommand';
import { getToolConfig } from '../../_shared/useToolConfig';
import { inpaintEraserClient } from './client';
import type { InpaintEraserRequest, InpaintEraserResult as InpaintEraserWorkerResult } from './worker.types';
import type { InpaintEraserModelEntry, InpaintEraserConfig } from './protocols';
import {
  MODEL_TYPE_KEY,
  BUILTIN_ERASER_MODELS,
  DEFAULT_INPAINT_ERASER_CONFIG,
  CMD_INPAINT_ERASER,
  CMD_INPAINT_ERASER_ABORT,
} from './protocols';
import { PLUGIN_AUTHOR, PLUGIN_ID } from '../../protocols';
import { inpaintEraserStore } from './store';
import type { InpaintEraserResult } from './store';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PLUGIN_UID = `${PLUGIN_AUTHOR}.${PLUGIN_ID}`;

function getInpaintConfig(ctx: { state: { pluginConfig: Record<string, unknown> } }): InpaintEraserConfig {
  return getToolConfig<InpaintEraserConfig>(ctx.state.pluginConfig, PLUGIN_UID, MODEL_TYPE_KEY, DEFAULT_INPAINT_ERASER_CONFIG);
}

/**
 * Convert LocalPolygon rings (LocalPoint[][]) to number[][][] for Worker.
 */
function ringsToNumberArrays(rings: Array<Array<{ x: number; y: number }>>): number[][][] {
  return rings.map(ring => ring.map(pt => [pt.x, pt.y]));
}

// ─── Tool Commands (via createToolCommand factory) ───────────────────────────

const { runCommand, abortCommand } = createToolCommand<
  Omit<InpaintEraserRequest, 'reqId'>,
  InpaintEraserWorkerResult,
  InpaintEraserResult,
  InpaintEraserModelEntry
>({
  id: { run: CMD_INPAINT_ERASER, abort: CMD_INPAINT_ERASER_ABORT },
  name: { run: 'AI Smart Erase', abort: 'Cancel Smart Erase' },
  store: inpaintEraserStore,
  client: inpaintEraserClient,
  configKey: MODEL_TYPE_KEY,
  defaultConfig: DEFAULT_INPAINT_ERASER_CONFIG,
  builtins: BUILTIN_ERASER_MODELS,
  toolName: 'Smart Eraser',
  noResultMessage: 'Inpainting produced no output',

  preCheck: (_imageData, _entry, ctx) => {
    const clipBox = getClipBox(ctx.activeFrame!);
    if (!clipBox || !clipBox.rings || clipBox.rings.length === 0) {
      return 'No selection — use rect, lasso, wand, or SAM to select an area first';
    }
    return null;
  },

  setRequest: (entry, imageData, ctx) => {
    const clipBox = getClipBox(ctx.activeFrame!);

    // Convert clipBox rings to layer-local coordinates
    const layerLocalPoly = ctx.geometry.polygon.frameLocalToLayerLocal(clipBox!, ctx.activeFrame!, ctx.activeLayer!);
    const polygonRings = ringsToNumberArrays(layerLocalPoly.rings as unknown as Array<Array<{ x: number; y: number }>>);

    // Compute mask bounds (bounding box of the polygon in layer-local coords)
    const polyBounds = layerLocalPoly.rect;
    const maskBounds = {
      x: Math.max(0, Math.floor(polyBounds.x)),
      y: Math.max(0, Math.floor(polyBounds.y)),
      w: Math.min(imageData.width - Math.max(0, Math.floor(polyBounds.x)), Math.ceil(polyBounds.w)),
      h: Math.min(imageData.height - Math.max(0, Math.floor(polyBounds.y)), Math.ceil(polyBounds.h)),
    };

    return {
      modelId: entry.modelId,
      onnxFile: entry.onnxFile,
      backend: entry.backend ?? 'ort',
      device: entry.device ?? 'wasm',
      imageData: {
        data: imageData.data.buffer,
        width: imageData.width,
        height: imageData.height,
      },
      polygonRings,
      maskBounds,
      inputSize: entry.inputSize,
    };
  },

  getResult: async (workerResult, ctx, elapsedMs): Promise<ProcessResultOutcome<InpaintEraserResult> | null> => {
    const { actions } = ctx;
    const frameId = ctx.activeFrame!.id;
    const layerId = ctx.activeLayer!.id;

    // Validate target frame/layer still exists
    const targetFrame = ctx.state.frames.byId[frameId];
    if (!targetFrame) {
      actions.setInteraction({ hud: { message: 'Inpainting complete, but target canvas was closed', type: 'info' } });
      return null;
    }
    const targetLayer = targetFrame.layers.byId[layerId];
    if (!targetLayer) {
      actions.setInteraction({ hud: { message: 'Inpainting complete, but target layer was deleted', type: 'info' } });
      return null;
    }

    if (!workerResult.patchData || !workerResult.width || !workerResult.height) return null;

    const { patchData, offsetX = 0, offsetY = 0, width: patchW, height: patchH } = workerResult;

    // Convert patch ArrayBuffer → PNG Blob
    const patchCanvas = new OffscreenCanvas(patchW, patchH);
    const pctx = patchCanvas.getContext('2d')!;
    const patchImgData = new ImageData(new Uint8ClampedArray(patchData), patchW, patchH);
    pctx.putImageData(patchImgData, 0, 0);
    const blob = await patchCanvas.convertToBlob({ type: 'image/png' });

    // Register as Asset
    const { assetId, url } = await ctx.assets.register(blob, { w: patchW, h: patchH });

    // Read output mode from config
    const inpaintConfig = getInpaintConfig(ctx);
    const outputMode = inpaintConfig.outputMode ?? 'new-layer';

    if (outputMode === 'replace') {
      // ── Replace mode: composite patch onto source layer in-place ──────────
      // Draw the original layer pixels, then overlay the patch at the correct offset.
      const srcW = targetLayer.bounding.w;
      const srcH = targetLayer.bounding.h;
      const compositeCanvas = new OffscreenCanvas(srcW, srcH);
      const cctx = compositeCanvas.getContext('2d')!;

      // Draw source layer image
      const srcBitmap = await fetch(targetLayer.src).then(r => r.blob()).then(b => createImageBitmap(b));
      cctx.drawImage(srcBitmap, 0, 0);
      srcBitmap.close();

      // Overlay patch at the correct layer-local offset
      const patchBitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(patchData), patchW, patchH));
      cctx.drawImage(patchBitmap, offsetX, offsetY);
      patchBitmap.close();

      // Convert composited result to a new asset
      const compositeBlob = await compositeCanvas.convertToBlob({ type: 'image/png' });
      const compositeAsset = await ctx.assets.register(compositeBlob, { w: srcW, h: srcH });

      // Update source layer in-place
      actions.updateLayer(frameId, layerId, { src: compositeAsset.url, assetId: compositeAsset.assetId });
    } else {
      // ── New Layer mode (default): create patch layer above source ────────
      // Calculate world coordinates (cx, cy) for patch center
      const canvasW = targetFrame.canvas.w;
      const canvasH = targetFrame.canvas.h;
      const cx = offsetX + patchW / 2 - canvasW / 2;
      const cy = offsetY + patchH / 2 - canvasH / 2;

      // Create a new patch Layer
      const layersArray = targetFrame.layers.order.map(id => targetFrame.layers.byId[id]);
      const newLayer = ctx.layers.getNewLayer({
        name: ctx.layers.getNewLayerName(layersArray, 'Erased'),
        src: url,
        assetId,
        cx,
        cy,
        bounding: { w: patchW, h: patchH },
        visibleShape: asLocalShape({ x: 0, y: 0, w: patchW, h: patchH }),
      });

      // Insert above source layer
      ctx.layers.addLayer(frameId, newLayer);
    }

    if (workerResult.debug) {
      console.log(`[InpaintEraser] ${workerResult.debug.deviceUsed} | inference: ${workerResult.debug.inferenceMs.toFixed(0)}ms | total: ${workerResult.debug.totalMs.toFixed(0)}ms`);
    }

    return {
      result: {
        deviceUsed: workerResult.debug?.deviceUsed ?? 'wasm',
        inferenceMs: workerResult.debug?.inferenceMs ?? elapsedMs,
        totalMs: workerResult.debug?.totalMs ?? elapsedMs,
        outputWidth: patchW,
        outputHeight: patchH,
        frameId,
      },
      hudMessage: outputMode === 'replace'
        ? `✨ Smart Erase complete — layer updated in place (${(elapsedMs / 1000).toFixed(1)}s)`
        : `✨ Smart Erase complete — patch layer created (${(elapsedMs / 1000).toFixed(1)}s)`,
      hudType: 'success',
    };
  },
});

// ─── Exported Commands ───────────────────────────────────────────────────────

export const INPAINT_ERASER_COMMANDS = {
  inpaintEraser: runCommand,
  abortInpaint: abortCommand,
};
