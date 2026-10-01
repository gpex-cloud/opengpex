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
import { getClipBox } from '@opengpex/editor/core/helpers/selection';

import { calcFinalDims } from './utils';

import * as P from './protocols';

/**
 * IMAGE_INFO_COMMANDS: Declarative command configurations.
 *
 * ── Phase 4 PR-2 note (WebGPU unified export, §11 / §16.2.1) ─────────────────
 * Export now goes through the SINGLE WebGPU RenderGraph, exactly like on-screen
 * preview (One Pipeline, spec §1.2):
 *
 *   1. Pass-through (unedited + full-frame + format match + sourceBlob) → the
 *      original file bytes are downloaded verbatim (avoids re-compression /
 *      preserves original ICC/EXIF). Never touches the RenderGraph.
 *   2. Otherwise: re-assemble the SAME frame's Scene → `engine.export()` reads
 *      back the composite (premultiplied LINEAR RGBA) → `exportEncode`
 *      un-premultiplies + TRC-encodes via the SAME `linearToSrgb` as view.wgsl
 *      (§16.2.1 single encode point) → `files.encode` for container + ICC.
 *
 * DEFERRED (clear TODOs, out of PR-2 scope):
 *   • 16/32-bit encoded output (PNG16/TIFF16 via the naked-pixel
 *     `fileIO.encodeTiff` worker path). PR-2 is 8-bit end-to-end.
 *   • `export()` region/scale: its signature is full-document only, so clip is a
 *     CPU crop and resize is a post-encode canvas scale (below).
 *   • Fine-grained pass-through param sensitivity (quality/compression/DPI/ICC
 *     toggle "isUnchanged"): PR-2 only fast-paths the untouched full-default case.
 */
export const IMAGE_INFO_COMMANDS = {
   download: {
      id: P.CMD_DOWNLOAD,
      name: 'Download Creation',
      category: 'File',
      execute: async (ctx: EditorContextValue, payload?: { format?: P.ExportFormat }) => {
         const { activeFrame, pixels, geometry } = ctx;
         const { selfConfig } = ctx.scoped || {};
         if (!activeFrame) return;

         const baseConfig = selfConfig as P.ExportConfig;
         // Optional one-shot format override (e.g. from the Agent's export_image
         // tool). Does NOT mutate the user's persisted UI selection — it only
         // affects this single export. Falls back to the UI-configured format.
         const config: P.ExportConfig = payload?.format
            ? { ...baseConfig, format: payload.format }
            : baseConfig;

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
         const clipShape: LocalShape | undefined = isClipMode && box ? geometry.polygon.polygonToShape(box) : undefined;
         const baseW = clipShape ? clipShape.rect.w : activeFrame.canvas.w;
         const baseH = clipShape ? clipShape.rect.h : activeFrame.canvas.h;
         const { w: exportW, h: exportH } = calcFinalDims(baseW, baseH, config);

         try {
            // ═══ 3. Egest decision + GPU render + encode → Blob ═══════════════
            // Delegated to `actions.adv.frame.export.encode` (core/advanced/commands/
            // frame/export.ts) — owns the pass-through fast path AND the full
            // WebGPU readback/encode path (spec §11 pass-through, §16.2.1 single
            // encode point). This command only triggers the actual browser save.
            const { blob, filename } = await ctx.actions.adv.frame.export.encode.execute({
               exportWidth: exportW,
               exportHeight: exportH,
               region: clipShape?.rect,
               config,
            });

            // ═══ 4. Download ═════════════════════════════════════════════════
            await pixels.utils.download(blob, filename);
         } catch (err) {
            console.error('[ExportPanel] Download failed:', err);
         }
      },
      shortcuts: [{ key: 's', meta: true, shift: true }, { key: 's', ctrl: true, shift: true }]
   } as EditorCommand<{ format?: P.ExportFormat } | void, Promise<void>>,

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
