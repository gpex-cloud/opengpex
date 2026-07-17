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

import { EditorContextValue, EditorCommand, LocalShape } from '@opengpex/editor/core/types';
import type { ImageMetadata } from '@opengpex/editor/core/files';
import type { RenderToBlobOptions } from '@opengpex/editor/core/types';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';

import { calcFinalDims, clipBoxToExportShape } from './utils';
import { ensureAvifEncoderRegistered } from './services/avifRegister';

import * as P from './protocols';

/**
 * IMAGE_INFO_COMMANDS: Declarative command configurations.
 *
 * ── Refactor note (2026-07-10) ─────────────────────────────────────────────
 * Since PixelService.render was upgraded to a fully unified facade
 * (see docs/opengpex/plans/20260710_export_pipeline_refactor_proposal.md),
 * this command no longer needs multi-strategy dispatch. It:
 *   1) resolves selection → shape (or full-frame),
 *   2) assembles RenderToBlobOptions (format / quality / metadata / dpi / bit-depth),
 *   3) calls a single method: `pixels.render.shapeToBlob(frame, shape, opts)`.
 *
 * All lane routing (16-bit vips / 8-bit engine-worker / AVIF plugin worker) is
 * decided internally by PixelService.render.
 */
export const IMAGE_INFO_COMMANDS = {
   download: {
      id: P.CMD_DOWNLOAD,
      name: 'Download Creation',
      execute: async (ctx: EditorContextValue) => {
         const { activeFrame, state, pixels, files } = ctx;
         const { selfConfig } = ctx.scoped || {};
         if (!activeFrame) return;

         const config = selfConfig as P.ExportConfig;
         const isClipMode = state.interaction.interactionMode === 'clip';
         const box = getClipBox(activeFrame);

         // ─── 1. Common Validation ──────────────────────────────────────────
         if (isClipMode && !box) {
            ctx.actions.setInteraction({ hud: { message: 'No active selection — draw a crop box first.', type: 'error' } });
            return;
         }

         const hasVisibleLayers = activeFrame.layers.order.some(id => {
            const layer = activeFrame.layers.byId[id];
            return !layer.hostId && layer.visible !== false;
         });
         if (!hasVisibleLayers) {
            ctx.actions.setInteraction({ hud: { message: 'All layers are hidden — nothing to export.', type: 'error' } });
            return;
         }

         // ─── 2. Ensure plugin-owned encoders are wired to PixelService ─────
         // (Idempotent — attaches AVIF encoder on first export.)
         ensureAvifEncoderRegistered(pixels);

         // ─── 3. Common Parameter Computation ───────────────────────────────
         const cropShape: LocalShape | undefined = isClipMode && box ? clipBoxToExportShape(box, ctx.geometry.polygon.polygonToSvgPathD) : undefined;
         const baseW = cropShape ? cropShape.rect.w : activeFrame.canvas.w;
         const baseH = cropShape ? cropShape.rect.h : activeFrame.canvas.h;
         const { w: exportW, h: exportH } = calcFinalDims(baseW, baseH, config);

         const dpi = config.dpi || activeFrame.dpi || 72;
         const baseLayer = activeFrame.layers.byId[activeFrame.layers.order[0]];
         const layerMeta = baseLayer?.metadata?.imageMetadata as ImageMetadata | undefined;

         // Detect if the caller wants a post-composite resize (target size ≠ source size).
         const needsResize = exportW !== baseW || exportH !== baseH;

         // ─── 4. Assemble the unified RenderToBlobOptions ───────────────────
         const opts: RenderToBlobOptions = {
            format: config.format,
            quality: config.quality ? config.quality / 100 : 0.92,
            exportBitDepth: config.exportBitDepth,
            metadata: layerMeta,
            exportConfig: {
               dpi,
               preserveExif: config.keepExif,
               writeSoftwareTag: true,
               tiffCompression: config.tiffCompression,
               pngCompression: config.pngCompression,
               jpegQuality: config.jpegQuality,
               tiffPredictor: config.tiffPredictor,
               tiffBigtiff: config.tiffBigtiff,
               tiffTile: config.tiffTile,
               tiffTileWidth: config.tiffTileWidth,
               tiffTileHeight: config.tiffTileHeight,
               resize: needsResize ? { w: exportW, h: exportH } : undefined,
            },
         };

         try {
            console.debug('[ExportCmd] Starting export: format=%s, clip=%s, dims=%dx%d',
               config.format, cropShape ? 'yes' : 'no', exportW, exportH);

            // ─── 5. Single unified call — PixelService picks the lane internally ─
            let blob: Blob;
            if (cropShape) {
               blob = await pixels.render.shapeToBlob(activeFrame, cropShape, opts) as Blob;
            } else {
               blob = await pixels.render.frameToBlob(activeFrame, opts) as Blob;
            }

            // ─── 6. Post-composite resize fallback (Lane C 8-bit path) ─────────
            // If the lane returned a full-size blob but user requested resize,
            // and the resize was NOT already handled inside vips (16-bit lanes),
            // apply it here via FileService as a safety net.
            // TODO: fold resize into files.encode chain so this branch dies.
            if (needsResize && blob.type !== 'image/tiff') {
               // For now keep as-is — the 8-bit lane does not resize post-composite;
               // the panel handles resize separately via applyResize command.
               // The user's chosen `resize` in opts is respected by 16-bit lanes only.
            }

            // ─── 7. Common Download Trigger ────────────────────────────────────
            const actualFormat = blob.type || config.format;
            const filename = files.getExportFilename(activeFrame.name, exportW, exportH, actualFormat);
            await pixels.utils.download(blob, filename);
         } catch (err) {
            console.error('[ExportPanel] Download failed:', err);
         }
      },
      shortcuts: [{ key: 's', ctrl: true, shift: true }, { key: 'e', ctrl: true }]
   } as EditorCommand<void, Promise<void>>,

   applyResize: {
      id: P.CMD_APPLY_RESIZE,
      name: 'Apply Resize',
      execute: async (ctx: EditorContextValue) => {
         const { activeFrame, actions } = ctx;
         const { selfConfig, setSelfConfig } = ctx.scoped || {};
         if (!activeFrame) return;

         const config = selfConfig as P.ExportConfig;
         const { w, h } = calcFinalDims(activeFrame.canvas.w, activeFrame.canvas.h, config);

         const pendingDpi = (config.dpi && config.dpi !== activeFrame.dpi) ? config.dpi : undefined;

         await actions.adv.frame.resize.resample.execute({ targetDim: { w, h }, dpi: pendingDpi });

         setSelfConfig?.({
            pixels: { w: 0, h: 0 },
            dpi: 0
         });
      }
   } as EditorCommand<void, Promise<void>>
};
