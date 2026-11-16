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
import type { GifHandler } from '@opengpex/editor/core/files/handlers/gif';
import { blobToImageData } from '@opengpex/editor/core/engine/utils/pixel-utils';

import * as P from './protocols';
import { detectAnimatedImageSequences, frameDelayOf } from './sequence';

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
   const { files } = ctx;

   // The shared sequence orchestration: membership/order identical to what
   // playback plays — every host layer of an animation frame, in layer-stack
   // order — so an exported GIF never diverges from what was previewed.
   const sequences = detectAnimatedImageSequences(activeFrame);
   const sequenceLayers = sequences.length > 0 ? sequences[0].layers : [];

   // If no multi-frame sequence found, export single frame
   if (sequenceLayers.length <= 1) {
      const result = await pixels.render.compositeFrame(activeFrame);
      const bitmap = await createImageBitmap(result.displayBlob);
      return files.encode(bitmap, 'image/gif', {});
   }

   // Animated export: composite each frame through the real render pipeline
   ctx.actions.notifyHUD(`Encoding GIF: ${sequenceLayers.length} frames...`, 'info');

   const { w, h } = activeFrame.canvas;
   const gifFrames: Array<{ rgba: Uint8Array; width: number; height: number; delay: number }> = [];

   for (const seqLayer of sequenceLayers) {
      // Per-frame delay or global override — computed for every layer, with or
      // without an asset (a blank layer is still a frame on the timeline).
      const delay = config.frameRateOverride > 0
         ? Math.round(1000 / config.frameRateOverride)
         : frameDelayOf(seqLayer);

      // SOLO COMPOSITE (what the player shows): composite the whole frame with
      // only this layer visible. Handed-drawing the layer's asset would ignore
      // its pose (position/size/masks/adjustments) and stretch whatever the
      // asset's intrinsic size is onto the full canvas — correct only for
      // imported GIF frames whose asset happens to be canvas-sized, absurd for
      // any painted/pasted layer. One full composite per frame also makes
      // asset-less layers transparent frames by construction (no special case).
      const composited = await pixels.render.compositeFrame(soloLayerView(activeFrame, seqLayer.id));
      const imageData = await blobToImageData(composited.displayBlob);

      gifFrames.push({
         rgba: new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength),
         width: w,
         height: h,
         delay,
      });
   }

   if (gifFrames.length === 0) {
      throw new Error('No valid frame assets found for GIF export');
   }

   // config.loop: boolean → GIF loop count: 0 = infinite loop, 1 = play once
   const gifHandler = files.getHandlerByMimeType('image/gif') as GifHandler;
   return gifHandler.encodeSequence(gifFrames, { loop: config.loop ? 0 : 1 });
}

/**
 * soloLayerView — a read-only frame view in which exactly one HOST layer is
 * visible (sub-lives follow their host untouched). Pure shallow copy: nothing
 * is written to the document. This is the export-side twin of what playback
 * shows (the pipeline hides every other sequence layer via the stage filter).
 */
function soloLayerView(frame: Frame, layerId: string): Frame {
   const byId: Record<string, Layer> = {};
   for (const [id, layer] of Object.entries(frame.layers.byId)) {
      byId[id] = layer.hostId ? layer : { ...layer, visible: id === layerId };
   }
   return { ...frame, layers: { byId, order: frame.layers.order } };
}
