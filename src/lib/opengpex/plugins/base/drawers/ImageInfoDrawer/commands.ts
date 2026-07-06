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

import { EditorContextValue, EditorCommand } from '@opengpex/editor/core/types';
import type { ImageMetadata } from '@opengpex/editor/core/files';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';

import { calcFinalDims, clipBoxToExportShape } from './utils';
import { FormatConverter } from './services/FormatConverter';

import * as P from './protocols';

/**
 * IMAGE_INFO_COMMANDS: Declarative command configurations.
 */
export const IMAGE_INFO_COMMANDS = {
   download: {
      id: P.CMD_DOWNLOAD,
      name: 'Download Creation',
      execute: async (ctx: EditorContextValue) => {
         const { activeFrame, state, pixels } = ctx;
         const { selfConfig } = ctx.scoped || {};
         if (!activeFrame) return;

         const config = selfConfig as P.ExportConfig;
         const isClipMode = state.interaction.interactionMode === 'clip';
         const box = getClipBox(activeFrame);

         // Guard: abort if in clip mode but no active selection
         if (isClipMode && !box) {
            ctx.actions.setInteraction({ hud: { message: 'No active selection — draw a crop box first.', type: 'error' } });
            return;
         }

         // Guard: abort if no visible layers exist (would produce a blank transparent image)
         const hasVisibleLayers = activeFrame.layers.order.some(id => {
            const layer = activeFrame.layers.byId[id];
            return !layer.hostId && layer.visible !== false;
         });
         if (!hasVisibleLayers) {
            ctx.actions.setInteraction({ hud: { message: 'All layers are hidden — nothing to export.', type: 'error' } });
            return;
         }

         // Resolve the export shape: for irregular selections (lasso/wand),
         // convert polygon to LocalShape{type:'path'} with bounds-relative pathData.
         const cropBox = isClipMode && box ? clipBoxToExportShape(box) : undefined;

         const baseW = isClipMode && cropBox ? cropBox.rect.w : activeFrame.canvas.w;
         const baseH = isClipMode && cropBox ? cropBox.rect.h : activeFrame.canvas.h;

         const { w: exportW, h: exportH } = calcFinalDims(baseW, baseH, config);

         try {
            console.debug('[ExportCmd] Starting export: format=%s, clip=%s, dims=%dx%d, visibleLayers=%d',
               config.format, isClipMode ? 'yes' : 'no', exportW, exportH,
               activeFrame.layers.order.filter(id => {
                  const l = activeFrame.layers.byId[id];
                  return !l.hostId && l.visible !== false;
               }).length
            );

            const { files } = ctx;
            const dpi = config.dpi || activeFrame.dpi || 72;

            // Retrieve layer metadata for EXIF passthrough
            const baseLayer = activeFrame.layers.byId[activeFrame.layers.order[0]];
            const layerMeta = baseLayer?.metadata?.imageMetadata as ImageMetadata | undefined;

            let blob: Blob;

            if (config.format === 'image/avif') {
               // AVIF: use dedicated worker path (FormatConverter handles AVIF encoding)
               blob = await FormatConverter.export(ctx, {
                  format: config.format,
                  quality: config.quality,
                  isClipMode: !!(isClipMode && cropBox),
                  cropBox
               });
            } else if (config.format === 'image/tiff') {
               // TIFF: render raw bitmap → TiffHandler.encode via files service
               const bitmap = (isClipMode && cropBox
                  ? await pixels.render.shapeToBlob(activeFrame, cropBox, { format: 'raw', quality: 1 })
                  : await pixels.render.frameToBlob(activeFrame, { format: 'raw', quality: 1 })) as ImageBitmap;

               blob = await files.encode(bitmap, config.format, {
                  quality: 1,
                  tiffCompression: config.tiffCompression || 'none',
                  metadata: layerMeta,
                  exportConfig: {
                     dpi,
                     writeSoftwareTag: true,
                  }
               } as import('@opengpex/editor/core/files').EncodeOptions & { tiffCompression?: string });
            } else {
               // JPEG/PNG/BMP/WebP: render raw bitmap → files.encode (unified metadata injection)
               const bitmap = (isClipMode && cropBox
                  ? await pixels.render.shapeToBlob(activeFrame, cropBox, { format: 'raw', quality: 1 })
                  : await pixels.render.frameToBlob(activeFrame, { format: 'raw', quality: 1 })) as ImageBitmap;

               blob = await files.encode(bitmap, config.format, {
                  quality: config.quality ? config.quality / 100 : 0.92,
                  metadata: layerMeta,
                  exportConfig: {
                     dpi,
                     preserveExif: config.keepExif,
                     writeSoftwareTag: true,
                  }
               });
            }

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

         // Pass pending DPI along with dimensions so it's bundled in the same undo snapshot
         const pendingDpi = (config.dpi && config.dpi !== activeFrame.dpi) ? config.dpi : undefined;

         // Use the advanced facade — dpi is included in the same updateFrame call for atomic undo
         await actions.adv.frame.resize.resample.execute({ targetDim: { w, h }, dpi: pendingDpi });

         // Reset pending overrides
         setSelfConfig?.({
            pixels: { w: 0, h: 0 },
            dpi: 0  // Clear pending DPI (now committed)
         });
      }
   } as EditorCommand<void, Promise<void>>
};


