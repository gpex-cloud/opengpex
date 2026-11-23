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

import { EditorContextValue, asLocalShape } from '@opengpex/editor/core/types';
import { createToolCommand } from '../_shared/control/createToolCommand';
import type { ProcessResultOutcome } from '../_shared/control/createToolCommand';
import { getToolConfig } from '../_shared/useToolConfig';
import { denoiserClient } from './client';
import type { DenoiseRequest, DenoiseResult as DenoiseWorkerResult } from './worker.types';
import { PLUGIN_AUTHOR, PLUGIN_ID } from '../protocols';
import type { DenoiseConfig, NafNetModelEntry } from './protocols';
import {
  MODEL_TYPE_KEY,
  BUILTIN_DENOISE_MODELS,
  DEFAULT_DENOISE_CONFIG,
  CMD_DENOISE,
  CMD_DENOISE_ABORT,
} from './protocols';
import { denoiserStore } from './store';
import type { DenoiseResult } from './store';
import {
  decodeNakedToF32,
  quantizeRgbaF32To16,
  narrowRasterToSrgb,
  encodeRgbaF32ToF16,
} from '../_shared/inference/highDepthSource';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PLUGIN_UID = `${PLUGIN_AUTHOR}.${PLUGIN_ID}`;

function getDenoiseConfig(ctx: EditorContextValue): DenoiseConfig {
  return getToolConfig<DenoiseConfig>(ctx.state.pluginConfig, PLUGIN_UID, MODEL_TYPE_KEY, DEFAULT_DENOISE_CONFIG);
}

// ─── Tool Commands (via createToolCommand factory) ───────────────────────────

const { runCommand, abortCommand } = createToolCommand<
  Omit<DenoiseRequest, 'reqId'>,
  DenoiseWorkerResult,
  DenoiseResult,
  NafNetModelEntry
>({
  id: { run: CMD_DENOISE, abort: CMD_DENOISE_ABORT },
  name: { run: 'AI Denoise Layer', abort: 'Cancel Denoise' },
  store: denoiserStore,
  client: denoiserClient,
  configKey: MODEL_TYPE_KEY,
  defaultConfig: DEFAULT_DENOISE_CONFIG,
  builtins: BUILTIN_DENOISE_MODELS,
  toolName: 'AI Denoise',
  noResultMessage: 'Denoise produced no output',

  setRequest: (entry, imageData, ctx) => {
    const dnConfig = getDenoiseConfig(ctx);
    const tileSize = dnConfig.tileSize ?? 256;

    return {
      modelId: entry.modelId,
      onnxFile: entry.onnxFile,
      backend: entry.backend ?? 'ort',
      device: entry.device ?? 'webgpu',
      tileSize,
      imageData: {
        data: imageData.data.buffer as ArrayBuffer,
        width: imageData.width,
        height: imageData.height,
      },
    };
  },

  // ── 16-bit precision source resolution ──
  // When the active layer's asset declares a persisted high-depth truth
  // (`dec:` naked pixels, sRGB-TRC encoded, sRGB/P3 gamut), the 8-bit
  // imageData payload is REPLACED by an interleaved RGBA f32 [0, 1] raster
  // decoded from that truth — the model domain is f32 [0, 1] either way, this
  // only removes the 8-bit quantization at the pipeline ends. Everything else
  // (linear-trc wide-gamut / RAW lines, missing dec buffer) degrades to the
  // legacy 8-bit path unchanged.
  buildRequest: async (ctx, defaultRequest) => {
    const assetId = ctx.activeLayer?.assetId;
    if (!assetId) return defaultRequest;

    const record = ctx.assets.get(assetId);
    if (!record?.dataFormat) return defaultRequest;
    // Training domain gate: the denoiser models are trained on sRGB-encoded
    // display-referred photos. Linear-trc sources (wide-gamut TIFF / RAW / EXR
    // dec lines) would need the render pipeline's full TRC + filmic narrowing
    // — out of scope here, so they fall back to the 8-bit display path.
    if (record.trc !== 'srgb-trc') return defaultRequest;
    if (record.gamut !== 'srgb' && record.gamut !== 'display-p3' && record.gamut !== 'adobe-rgb') {
      return defaultRequest;
    }

    const dec = await ctx.assets.getDec(assetId);
    if (!dec) return defaultRequest; // persist failure / mis-GC — 8-bit fallback

    // f32 [0, 1] raster over the FULL image.
    let raster = decodeNakedToF32(dec, record.dataFormat);
    // Wide-gamut source → narrow to sRGB before inference (honest clip of
    // out-of-gamut colours; srgb input passes through unchanged).
    raster = narrowRasterToSrgb(raster, record.gamut as 'srgb' | 'display-p3' | 'adobe-rgb');

    return {
      ...defaultRequest,
      // Exactly one pixel channel must ride the request — drop the 8-bit one.
      imageData: undefined,
      f32ImageData: { data: raster.buffer as ArrayBuffer, width: record.width, height: record.height },
    };
  },

  getResult: async (workerResult, ctx, elapsedMs): Promise<ProcessResultOutcome<DenoiseResult> | null> => {
    const { actions } = ctx;
    const frameId = ctx.activeFrame!.id;
    const targetLayer = ctx.activeLayer!;
    const targetFrame = ctx.state.frames.byId[frameId];
    if (!targetFrame) {
      actions.setInteraction({ hud: { message: 'Denoise complete, but target canvas was closed', type: 'info' } });
      return null;
    }

    if (!workerResult.imageData) return null;

    const { width: outW, height: outH, data: resultBuffer } = workerResult.imageData;
    const dnConfig = getDenoiseConfig(ctx);
    const outputMode = dnConfig.outputMode ?? 'new-layer';

    // Encode the denoised pixels and register them as an asset.
    const outCanvas = new OffscreenCanvas(outW, outH);
    const outCtx2d = outCanvas.getContext('2d')!;
    const outImgData = new ImageData(new Uint8ClampedArray(resultBuffer), outW, outH);
    outCtx2d.putImageData(outImgData, 0, 0);
    const blob = await outCanvas.convertToBlob({ type: 'image/png' });

    // ── 16-bit truth assembly (f32 precision path) ──
    // The worker ran on the f32 raster; its truth rides beside the 8-bit
    // display proxy through the highDepthData ingest channel so the result
    // re-enters the document at full depth.
    let naked16: Uint16Array | undefined;
    let colorIdentity16: { gamut: 'srgb'; trc: 'srgb-trc'; bitDepth: 16; dataFormat: 'rgba16float' } | undefined;
    if (workerResult.f32ImageData) {
      naked16 = encodeRgbaF32ToF16(new Float32Array(workerResult.f32ImageData.data));
      colorIdentity16 = { gamut: 'srgb', trc: 'srgb-trc', bitDepth: 16, dataFormat: 'rgba16float' };
    }

    // Output semantics:
    //   'new-layer' → full-size patch layer directly above the source
    //                 (non-destructive; denoise is resolution-preserving);
    //   'new-frame' → new trunk frame from the denoised image (canvas =
    //                 the image dimensions, via the same ingest path as the
    //                 upscaler's New Frame).
    if (outputMode === 'new-frame') {
      const frameName = targetFrame.name || 'Untitled';
      let file: File;
      if (naked16) {
        // 16-bit truth → raw-16 PNG (vips, no canvas hop) → trunk: the import
        // decode restores the high-depth `dec:` truth, so the new frame keeps
        // full precision. 8-bit sources take the plain PNG path.
        const u16 = quantizeRgbaF32To16(decodeNakedToF32(naked16, 'rgba16float'));
        const blob16 = await ctx.files.encode(
          { width: outW, height: outH, data: u16, bitDepth: 16, colorSpace: 'srgb' },
          'image/png',
          { exportConfig: { targetGamut: 'srgb' } },
        );
        file = new File([blob16], `${frameName}_denoised.png`, { type: 'image/png' });
      } else {
        file = new File([blob], `${frameName}_denoised.png`, { type: 'image/png' });
      }
      await actions.adv.frame.create.trunk.execute({ source: file });
    } else {
      const { assetId: patchAssetId, url: patchUrl } = await ctx.assets.register({
        displayBlob: blob,
        width: outW,
        height: outH,
        ...(naked16 && colorIdentity16 ? { highDepthData: naked16, colorIdentity: colorIdentity16 } : {}),
      });
      const layersArray = targetFrame.layers.order.map((id) => targetFrame.layers.byId[id]);
      const newLayer = ctx.layers.factory.createLayer('image', {
        name: ctx.layers.factory.getNewLayerName(layersArray, 'Denoiser'),
        src: patchUrl,
        assetId: patchAssetId,
        cx: targetLayer.cx,
        cy: targetLayer.cy,
        bounding: targetLayer.bounding,
        visibleShape: asLocalShape({ x: 0, y: 0, w: targetLayer.bounding.w, h: targetLayer.bounding.h }),
      });
      ctx.layers.factory.addLayer(frameId, newLayer);
    }

    if (workerResult.debug) {
      console.log(`[Denoise] ${workerResult.debug.deviceUsed} | tiles: ${workerResult.debug.tilesProcessed} | total: ${workerResult.debug.totalMs.toFixed(0)}ms`);
    }

    return {
      result: {
        deviceUsed: workerResult.debug?.deviceUsed ?? 'wasm',
        inferenceMs: workerResult.debug?.totalMs ?? elapsedMs,
        totalMs: workerResult.debug?.totalMs ?? elapsedMs,
        outputWidth: outW,
        outputHeight: outH,
        frameId,
      },
      hudMessage: outputMode === 'new-frame'
        ? `Denoise complete — new frame created (${(elapsedMs / 1000).toFixed(1)}s)`
        : `Denoise complete — patch layer created (${(elapsedMs / 1000).toFixed(1)}s)`,
      hudType: 'success',
    };
  },
});

// ─── Exported Commands ───────────────────────────────────────────────────────

export const DENOISE_COMMANDS = {
  denoise: runCommand,
  abortDenoise: abortCommand,
};
