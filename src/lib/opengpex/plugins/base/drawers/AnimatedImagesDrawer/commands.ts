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

import { EditorContextValue, EditorCommand, Frame, Layer } from '@opengpex/editor/core/types';
import { GifHandler } from '@opengpex/editor/core/files/handlers/gif';

import * as P from './protocols';

/**
 * ANIMATED_IMAGES_COMMANDS: Declarative command configurations for animated images plugin.
 */
export const ANIMATED_IMAGES_COMMANDS = {
   exportAnimation: {
      id: P.CMD_EXPORT_ANIMATED_IMAGE,
      name: 'Export Animation',
      execute: async (ctx: EditorContextValue) => {
         const { activeFrame, pixels } = ctx;
         const { selfConfig } = ctx.scoped || {};
         if (!activeFrame) return;

         const config = selfConfig as P.AnimatedImagesConfig;

         try {
            const blob = await exportAnimatedGif(ctx, activeFrame, pixels, config);

            const { files } = ctx;
            const filename = files.getExportFilename(
               activeFrame.name,
               activeFrame.canvas.w,
               activeFrame.canvas.h,
               'image/gif',
            );

            await pixels.utils.download(blob, filename);
         } catch (err) {
            console.error('[AnimatedImagesDrawer] Export failed:', err);
            ctx.actions.setInteraction({
               hud: { message: 'Animation export failed. See console for details.', type: 'error' },
            });
         }
      },
   } as EditorCommand<void, Promise<void>>,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Animated GIF Export: Multi-frame sequence export
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Export current frame as an animated GIF.
 *
 * Collects all GIF sequence layers (gifSequenceId metadata), loads each frame
 * layer's PNG asset, and encodes them into an animated GIF.
 */
async function exportAnimatedGif(
   ctx: EditorContextValue,
   activeFrame: Frame,
   pixels: EditorContextValue['pixels'],
   config: P.AnimatedImagesConfig,
): Promise<Blob> {
   const gifHandler = new GifHandler();

   // Collect GIF sequence layers (host layers only — no parentId)
   const hostLayers = activeFrame.layers.order
      .map(id => activeFrame.layers.byId[id])
      .filter((l): l is Layer => !!l && !l.hostId);

   const sequenceLayers = hostLayers
      .filter(l => l.metadata?.gifSequenceId)
      .sort((a, b) => ((a.metadata?.gifFrameIndex as number) || 0) - ((b.metadata?.gifFrameIndex as number) || 0));

   // If no multi-frame sequence found, export single frame
   if (sequenceLayers.length <= 1) {
      const bitmap = await pixels.render.frameToBlob(activeFrame, { format: 'raw', quality: 1 }) as ImageBitmap;
      return gifHandler.encode(bitmap, {});
   }

   // Animated export: load each frame layer's asset directly
   ctx.actions.notifyHUD(`Encoding GIF: ${sequenceLayers.length} frames...`, 'info');

   const { w, h } = activeFrame.canvas;
   const gifFrames: Array<{ rgba: Uint8Array; width: number; height: number; delay: number }> = [];

   for (const seqLayer of sequenceLayers) {
      // Load the frame layer's PNG asset directly (bypasses renderer)
      const src = seqLayer.src;
      if (!src) continue;

      const bitmap = await createImageBitmap(await fetch(src).then(r => r.blob()));

      // Extract RGBA from ImageBitmap
      const canvas = new OffscreenCanvas(w, h);
      const offCtx = canvas.getContext('2d')!;
      offCtx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();

      const imageData = offCtx.getImageData(0, 0, w, h);
      const rgba = new Uint8Array(imageData.data.buffer);

      // Use per-frame delay or global override
      const originalDelay = (seqLayer.metadata?.gifFrameDelay as number) || 100;
      const delay = config.frameRateOverride > 0
         ? Math.round(1000 / config.frameRateOverride)
         : originalDelay;

      gifFrames.push({ rgba, width: w, height: h, delay });
   }

   if (gifFrames.length === 0) {
      throw new Error('No valid frame assets found for GIF export');
   }

   // config.loop: boolean → GIF loop count: 0 = infinite loop, 1 = play once
   return gifHandler.encodeSequence(gifFrames, { loop: config.loop ? 0 : 1 });
}
