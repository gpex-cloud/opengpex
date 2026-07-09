/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Revert Command.
 *
 * Handles reverting a frame to its original source:
 * - GIF Revert: re-decodes original GIF and rebuilds frame layers in-place
 * - Standard Revert: re-hydrates original asset and resets transforms/masks
 */

'use client';

import { EditorCommand, EditorContextValue, asLocalShape, Layer } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { VIEWPORT_FIT_PADDING } from '@opengpex/editor/core/helpers/presets';
import * as P from '@opengpex/editor/core/advanced/protocols';

export const FrameRevertCommand = {
  id: P.ADV_FRAME_REVERT,
  name: 'Revert to Original',
  undoable: false,
  execute: async (ctx: EditorContextValue): Promise<void> => {
    const { geometry, activeFrame, actions, state, assets, pixels, files } = ctx;
    if (!activeFrame) return;

    // ═══════════════════════════════════════════════════════════════════════
    // GIF Revert Path: Re-decode original GIF and rebuild layers in-place
    // (same frame ID, same list position, cancel-safe)
    // ═══════════════════════════════════════════════════════════════════════
    const originalGifAssetId = (activeFrame.extra as Record<string, unknown>)?.originalGifAssetId as string | undefined;
    if (originalGifAssetId) {
      try {
        // 1. Hydrate the original GIF binary from asset store
        await assets.hydrate(new Set([originalGifAssetId]));
        const gifEntry = assets.get(originalGifAssetId);

        if (!gifEntry || !gifEntry.blob) {
          throw new Error('Original GIF asset not found in store');
        }

        // 2. Reconstruct a File object and re-decode to get all frames
        const originalName = activeFrame.name + '.gif';
        const gifFile = new File([gifEntry.blob], originalName, { type: 'image/gif' });

        const decoded = await files.decode(gifFile);
        if (!decoded.subImages || decoded.subImages.length <= 1 || decoded.subImages[0].delay == null) {
          throw new Error('Re-decoded GIF has no animation frames');
        }

        let framesToImport = decoded.subImages;
        const totalFrames = framesToImport.length;
        const GIF_DEFAULT_LIMIT = 30;

        // 3. Frame count selection dialog (user can cancel → frame stays untouched)
        if (totalFrames > GIF_DEFAULT_LIMIT) {
          const targetCounts = [10, 20, 30, 60, 100].filter(n => n < totalFrames);
          const limitOptions = targetCounts.map(target => {
            const step = Math.ceil(totalFrames / target);
            let actualCount = 0;
            for (let i = 0; i < totalFrames; i += step) actualCount++;
            return {
              id: String(step),
              label: `${actualCount} frames`,
              description: `Keep 1 of every ${step} frames`,
            };
          }).filter((opt, idx, arr) => idx === 0 || opt.label !== arr[idx - 1].label);

          limitOptions.push({
            id: '1',
            label: `All ${totalFrames} frames`,
            description: 'May use significant memory',
          });

          const chosenStep = await actions.askChoice(
            `GIF has ${totalFrames} frames`,
            limitOptions,
            `This animated GIF contains ${totalFrames} frames. Choose a frame limit for decimation.`,
          );

          if (!chosenStep) return; // User cancelled — frame stays as-is

          const step = parseInt(chosenStep, 10) || 1;
          if (step > 1) {
            const sampled: typeof framesToImport = [];
            for (let i = 0; i < totalFrames; i += step) {
              const frame = framesToImport[i];
              sampled.push({ ...frame, delay: (frame.delay || 100) * step, index: sampled.length });
            }
            framesToImport = sampled;
          }
        }

        // 4. Register new frame assets
        const dimension = decoded.dimensions;
        const gifSequenceId = `gif-seq-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 6)}`;

        const frameAssets = await Promise.all(
          framesToImport.map(async (f) => {
            const assetId = await assets.register(f.displayBlob);
            const assetUrl = assets.getURL(assetId)!;
            return { assetId, assetUrl, delay: f.delay || 100, index: f.index };
          }),
        );

        // 5. Build new layer structure
        const frameLayers: Layer[] = frameAssets.map((fa, i) => {
          return LayerFactory.getNewLayer({
            name: `Frame ${i + 1}`,
            src: fa.assetUrl,
            assetId: fa.assetId,
            cx: 0,
            cy: 0,
            locked: false,
            visible: i === 0,
            bounding: dimension,
            visibleShape: asLocalShape({ x: 0, y: 0, w: dimension.w, h: dimension.h }),
            metadata: {
              format: 'image/gif',
              size: gifEntry.blob!.size,
              source: 'local',
              originalName,
              gifSequenceId,
              gifFrameIndex: i,
              gifFrameDelay: fa.delay,
              gifTotalFrames: framesToImport.length,
            },
          });
        });

        const expandedLayers = frameLayers.flatMap(l => LayerFactory.expandLayers([l]));

        // 6. Camera + crop box
        const { insets } = state.ui.theme.config;
        const newCamera = geometry.camera.getFitCamera(
          state.ui.viewportDim,
          dimension,
          { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right },
        );

        // 7. In-place update — same frame ID, same list position
        actions.updateFrame(activeFrame.id, {
          canvas: dimension,
          camera: newCamera,
          clipBoxes: {},
          canvasCropBox: asLocalShape({
            x: dimension.w * 0.25,
            y: dimension.h * 0.25,
            w: dimension.w * 0.5,
            h: dimension.h * 0.5,
          }),
          layers: {
            byId: Object.fromEntries(expandedLayers.map(l => [l.id, l])),
            order: expandedLayers.map(l => l.id),
          },
          activeLayerId: frameLayers[0].id,
          extra: { ...(activeFrame.extra as Record<string, unknown>), gifSequenceId, gifFrameCount: framesToImport.length, originalGifAssetId },
        });

        actions.resetHistory();
        actions.setInteraction({ hud: { message: `GIF reverted: ${framesToImport.length} frames restored.`, type: 'success' } });
        return;
      } catch (err) {
        console.error('[FrameService] GIF revert failed:', err);
        actions.setInteraction({ hud: { message: 'Failed to revert GIF. See console for details.', type: 'error' } });
        return;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Standard Revert Path (non-GIF single-layer frames)
    // ═══════════════════════════════════════════════════════════════════════
    const baseLayer = activeFrame.layers.byId[activeFrame.layers.order[0]];
    if (!baseLayer) return;

    const originalAssetId = activeFrame.assetId || baseLayer.assetId;
    if (!originalAssetId) {
      actions.setInteraction({ hud: { message: 'Original asset ID missing.', type: 'error' } });
      return;
    }

    try {
      // 1. Physical layer hydration: ensure the original physical asset is loaded
      await assets.hydrate(new Set([originalAssetId]));
      const assetEntry = assets.get(originalAssetId);

      if (!assetEntry || !assetEntry.blob) {
        throw new Error('Original physical asset blob not found in store');
      }

      // 2. Generate a fresh ObjectURL binding
      const liveSrc = assets.resolve(originalAssetId) || URL.createObjectURL(assetEntry.blob);

      // 3. Re-decode dimensions and bounds from the original physical Blob
      const [dimension, contentBounds] = await Promise.all([
        pixels.decode.dimensions(liveSrc),
        pixels.decode.contentBounds(liveSrc),
      ]);

      const { insets } = state.ui.theme.config;

      // 4. Re-calculate the camera position fitting the viewport
      const newCamera = geometry.camera.getFitCamera(
        state.ui.viewportDim,
        dimension,
        { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right },
      );

      // 5. Assemble a minimal base layer, completely clear masks, and reset transform/filters
      const cleanBaseLayer = {
        ...baseLayer,
        assetId: originalAssetId,
        src: liveSrc,
        bounding: dimension,
        cx: 0,
        cy: 0,
        scale: 1,
        rotation: 0,
        flip: { h: false, v: false },
        adjustments: { brightness: 100, contrast: 100, saturation: 100, hueRotate: 0, blur: 0 },
        visibleShape: asLocalShape(contentBounds),
        vectorMasks: [],
        bitmapMasks: [],
      };

      // 6. Use LayerFactory to regenerate the cleanest triplet layers
      const refreshedLayers = LayerFactory.expandLayers([cleanBaseLayer]);

      const nextOrder = refreshedLayers.map(l => l.id);
      const nextById: Record<string, Layer> = {};
      refreshedLayers.forEach(l => (nextById[l.id] = l));

      // 7. Fully refresh artboard's canvas dimensions, camera, crop boxes, and layer data
      actions.updateFrame(activeFrame.id, {
        canvas: dimension,
        camera: newCamera,
        clipBoxes: {},
        canvasCropBox: asLocalShape({
          x: dimension.w * 0.25,
          y: dimension.h * 0.25,
          w: dimension.w * 0.5,
          h: dimension.h * 0.5,
        }),
        layers: { byId: nextById, order: nextOrder },
        activeLayerId: refreshedLayers[0]?.id,
      });

      // Clear undo/redo history — the old entries reference stale state
      actions.resetHistory();

      actions.setInteraction({ hud: { message: 'Frame reloaded and reverted to original.', type: 'success' } });
    } catch (err) {
      console.error('[FrameService] True revert reload failed:', err);
      actions.setInteraction({ hud: { message: 'Failed to reload original source.', type: 'error' } });
    }
  },
} as EditorCommand<void, Promise<void>>;

export const FrameRevertCommands = {
  revert: FrameRevertCommand,
};
