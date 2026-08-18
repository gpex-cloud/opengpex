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

import { EditorContextValue, EditorCommand, LocalShape, asLocalShape } from '@opengpex/editor/core/types';
import type { ImageMetadata, EncodeOptions, SourceFormat } from '@opengpex/editor/core/files';
import { canUseFastExport, shouldEmbedIcc } from '@opengpex/editor/core/color/ColorPipeline';
import { assetStore } from '@opengpex/editor/core/storage/asset/AssetStore';
import type { RenderToBlobOptions } from '@opengpex/editor/core/types';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';

import { calcFinalDims, clipBoxToExportShape } from './utils';

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
      category: 'File',
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

         // ─── 2. Common Parameter Computation ───────────────────────────────
         const cropShape: LocalShape | undefined = isClipMode && box ? clipBoxToExportShape(box) : undefined;
         const baseW = cropShape ? cropShape.rect.w : activeFrame.canvas.w;
         const baseH = cropShape ? cropShape.rect.h : activeFrame.canvas.h;
         const { w: exportW, h: exportH } = calcFinalDims(baseW, baseH, config);

         const dpi = config.dpi || activeFrame.dpi || 72;
         // Find source layer by isSource flag (stable across reorder/deletion), fallback to order[0]
         const sourceLayer = activeFrame.layers.order.map(id => activeFrame.layers.byId[id]).find(l => l.isSource)
           || activeFrame.layers.byId[activeFrame.layers.order[0]];
         const layerMeta = sourceLayer?.metadata?.imageMetadata as ImageMetadata | undefined;

         // Detect if the caller wants a post-composite resize (target size ≠ source size).
         const needsResize = exportW !== baseW || exportH !== baseH;

          // ─── 4. Assemble the unified RenderToBlobOptions ───────────────────
           // ICC embed decision: strategy-driven via shouldEmbedIcc()
            // Three-layer: format capability × strategy default × user override
            const mimeToFormat: Record<string, import('@opengpex/editor/core/files').SourceFormat> = {
              'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp',
              'image/avif': 'avif', 'image/tiff': 'tiff', 'image/bmp': 'bmp',
            };
            const exportFmt = mimeToFormat[config.format] || 'unknown';
            const userEmbedIccOverride = config.embedIccOverride; // undefined = use strategy default
            const embedIcc = shouldEmbedIcc(exportFmt, activeFrame.colorSpace, userEmbedIccOverride);
             console.log('[ExportCmd ICC] layerMeta.colorSpace=%s, hasIccData=%s, embedIcc=%s, userOverride=%s (strategy-driven)',
               layerMeta?.colorSpace, !!layerMeta?.raw?.icc?.data, embedIcc, userEmbedIccOverride);

          const opts: RenderToBlobOptions = {
             format: config.format,
             quality: config.quality ? config.quality / 100 : 0.92,
             exportBitDepth: config.exportBitDepth,
             metadata: layerMeta,
             exportConfig: {
                dpi,
                preserveExif: config.keepExif,
                writeSoftwareTag: true,
                 embedIcc,
                // Pass frame's working colorSpace to handler for export strategy routing
                frameColorSpace: activeFrame.colorSpace,
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

         // ─── 4.5 Fast-path: canUseFastExport ────────────────────────────────
         // When the frame is a single unedited layer exported to the same format,
         // we can skip composite + encode entirely and return the original sourceBlob.
         // This is the zero-computation lossless round-trip optimization.
         const allLayers = activeFrame.layers.order.map(id => activeFrame.layers.byId[id]);
         const visibleLayers = allLayers.filter(l => !l.hostId && l.visible !== false);

         // MIME → SourceFormat mapping for canUseFastExport
         const mimeToSourceFormat: Record<string, SourceFormat> = {
            'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp',
            'image/avif': 'avif', 'image/tiff': 'tiff', 'image/bmp': 'bmp',
         };
         const exportSourceFormat = mimeToSourceFormat[config.format] || 'unknown';

         // Determine if export parameters are unchanged from import defaults
         const isUnchanged = !needsResize
            && (!config.quality || config.quality === 92)
            && !config.tiffCompression;

         // ── sourceBlob: retrieve from AssetStore via base layer's assetId ──
         // The rawBlob was stored at import time via assets.register(displayBlob, { rawBlob })
         // and persisted in IndexedDB under key `raw:${assetId}`.
         const baseLayerAssetId = sourceLayer?.assetId;
         const sourceBlob: Blob | null = baseLayerAssetId
            ? await assetStore.getRaw(baseLayerAssetId)
            : null;

         // ── isEdited: history-based detection (method 3) ──
         // Per-frame undo history: past.length === 0 && !checkpoint === never edited.
         // Same pattern as CloudMenu sync dirty detection.
         const frameHistory = state.history.byFrameId[activeFrame.id];
         const isEdited = frameHistory
            ? (frameHistory.past.length > 0 || !!frameHistory.checkpoint)
            : false;

         const frameForFastExport = {
            layerCount: visibleLayers.length,
            isEdited,
            sourceBlob,
            sourceFormat: (layerMeta?.sourceFormat || 'unknown') as SourceFormat,
         };

         if (canUseFastExport(frameForFastExport, exportSourceFormat, isUnchanged)) {
            // Fast-path: return sourceBlob directly (skip composite + encode)
            const blob = frameForFastExport.sourceBlob!;
            const filename = files.getExportFilename(activeFrame.name, exportW, exportH, blob.type || config.format);
            await pixels.utils.download(blob, filename);
            console.debug('[ExportCmd] Fast-path: sourceBlob returned directly (zero compute)');
            return;
         }

         // ─── 5. Unified composite pipeline (Step 9) ─────────────────────────
         // compositeFrame handles hostId filtering, ROI conversion, TRC and colorSpace.
         const localRoi = cropShape
            ? cropShape
            : asLocalShape({ x: 0, y: 0, w: activeFrame.canvas.w, h: activeFrame.canvas.h });

         const precision = opts.exportBitDepth === 16 ? 16 : 8;

         const result = await pixels.render.compositeFrame(activeFrame, localRoi, { precision });

            // Encode the composite result via FileService handlers.
            // This ensures metadata injection (DPI, ICC profile, EXIF) is applied correctly.
            // PixelResult.toBlob() returns raw Worker output without metadata — we need
            // files.encode() which routes through PngHandler/JpegHandler/etc.
            const encodeOpts: EncodeOptions = {
               quality: opts.quality,
               metadata: opts.metadata,
               exportConfig: opts.exportConfig as EncodeOptions['exportConfig'],
            };

            // Get bitmap from composite result, then encode via file handler
            const bitmap = await createImageBitmap(await result.toBlob());
            const blob = await files.encode(bitmap, config.format, encodeOpts);
            bitmap.close();

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
      shortcuts: [{ key: 's', meta: true, shift: true }, { key: 's', ctrl: true, shift: true }]
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
