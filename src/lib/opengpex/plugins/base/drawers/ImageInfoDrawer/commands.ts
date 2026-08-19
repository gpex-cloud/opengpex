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
import type { EncodeOptions } from '@opengpex/editor/core/files';
import { mimeToFormat } from '@opengpex/editor/core/files';
import { shouldEmbedIcc } from '@opengpex/editor/core/color/ColorPipeline';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';

import { calcFinalDims, clipBoxToExportShape } from './utils';

import * as P from './protocols';

/**
 * IMAGE_INFO_COMMANDS: Declarative command configurations.
 *
 * ── Refactor note (2026-08-19 Unified Composite-8bit) ────────────────────────
 * Export logic always uses compositeFrame(frame, roi, { precision: 8 }) + encode.
 * The old resolveExportStrategy three-path routing (fast-export / fast-re-encode /
 * composite-8bit) has been removed. WebGPU will restore 16-bit support natively.
 */
export const IMAGE_INFO_COMMANDS = {
   download: {
      id: P.CMD_DOWNLOAD,
      name: 'Download Creation',
      category: 'File',
      execute: async (ctx: EditorContextValue) => {
         const { activeFrame, pixels, files } = ctx;
         const { selfConfig } = ctx.scoped || {};
         if (!activeFrame) return;

         const config = selfConfig as P.ExportConfig;
         const isClipMode = ctx.state.interaction.interactionMode === 'clip';
         const box = getClipBox(activeFrame);

         // ═══ 1. Validation ═══════════════════════════════════════════════════
         if (isClipMode && !box) {
            ctx.actions.setInteraction({ hud: { message: 'No active selection — draw a clip box first.', type: 'error' } });
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

         // ═══ 2. Compute export dimensions ═══════════════════════════════════
         const clipShape: LocalShape | undefined = isClipMode && box ? clipBoxToExportShape(box) : undefined;
         const baseW = clipShape ? clipShape.rect.w : activeFrame.canvas.w;
         const baseH = clipShape ? clipShape.rect.h : activeFrame.canvas.h;
         const { w: exportW, h: exportH } = calcFinalDims(baseW, baseH, config);

         const dpi = config.dpi || activeFrame.dpi || 72;
         const layerMeta = activeFrame.metadata;
         const needsResize = exportW !== baseW || exportH !== baseH;

         const exportFormat = mimeToFormat[config.format] ?? 'unknown';

         // ICC embed decision
         const userEmbedIccOverride = config.embedIccOverride;
         const embedIcc = shouldEmbedIcc(exportFormat, activeFrame.colorSpace, userEmbedIccOverride);

         // ═══ 3. Always composite-8bit ═══════════════════════════════════════
         try {
            const localRoi = clipShape
               ? clipShape
               : asLocalShape({ x: 0, y: 0, w: activeFrame.canvas.w, h: activeFrame.canvas.h });

            const result = await pixels.render.compositeFrame(activeFrame, localRoi, { precision: 8 });

            // Encode the composite result via FileService handlers.
            const encodeOpts: EncodeOptions = {
               quality: config.quality ? config.quality / 100 : 0.92,
               metadata: layerMeta,
               exportConfig: {
                  dpi,
                  preserveExif: config.keepExif,
                  writeSoftwareTag: true,
                  embedIcc,
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

            const bitmap = await createImageBitmap(await result.toBlob());
            const blob = await files.encode(bitmap, config.format, encodeOpts);
            bitmap.close();

            // ═══ 4. Download ═════════════════════════════════════════════════
            const actualFormat = blob.type || config.format;
            const filename = files.getExportFilename(activeFrame.name, exportW, exportH, actualFormat);
            await pixels.utils.download(blob, filename);
            // console.debug('[ExportCmd] Composite-8bit: encode completed, format=%s, dims=%dx%d', actualFormat, exportW, exportH);
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
