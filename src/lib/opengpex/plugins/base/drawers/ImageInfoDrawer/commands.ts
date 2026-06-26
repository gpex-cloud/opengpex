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
import { getClipBox } from '@opengpex/editor/core/helpers/selection';

import { MetadataHelper } from '@opengpex/editor/core/helpers/metadata';
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

         // Resolve the export shape: for irregular selections (lasso/wand),
         // convert polygon to LocalShape{type:'path'} with bounds-relative pathData.
         const cropBox = isClipMode && box ? clipBoxToExportShape(box) : undefined;

         const baseW = isClipMode && cropBox ? cropBox.rect.w : activeFrame.canvas.w;
         const baseH = isClipMode && cropBox ? cropBox.rect.h : activeFrame.canvas.h;

         const { w: exportW, h: exportH } = calcFinalDims(baseW, baseH, config);

         try {
            let blob = await FormatConverter.export(ctx, {
               format: config.format,
               quality: config.quality,
               isClipMode: !!(isClipMode && cropBox),
               cropBox
            });

            const actualFormat = (blob as Blob).type || config.format;
            if (actualFormat !== config.format) {
               console.warn(`[ExportDrawer] Browser fallback: Requested ${config.format} but browser produced ${actualFormat}.`);
            }

            const extension = actualFormat.split('/')[1] || 'png';
            const filename = await pixels.utils.getExportFilename(activeFrame.name, exportW, exportH, extension);

            const exif = activeFrame.layers.byId[activeFrame.layers.order[0]]?.metadata?.exif;
            if (config.keepExif && exif) {
               blob = await MetadataHelper.injectToBlob(blob as Blob, {
                  engine: 'canvas2d',
                  version: '2.1.0-hybrid',
                  renderMode: 'original',
                  timestamp: Date.now(),
                  isSafeExport: true,
                  viewportScale: 1
               }, exif);
            }

            await pixels.utils.download(blob as Blob, filename);
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

         // Use the advanced facade instead of raw command execution
         await actions.adv.frame.resize.resample.execute({ targetDim: { w, h } });

         setSelfConfig?.({
            pixels: { w: 0, h: 0 }
         });
      }
   } as EditorCommand<void, Promise<void>>
};

