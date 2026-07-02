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

import { EditorCommand, EditorContextValue, Frame, LocalShape, asLocalShape, Layer } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { MetadataHelper } from '@opengpex/editor/core/helpers/metadata';
import { extractDpiFromExif, DPI_PRESETS } from '@opengpex/editor/core/helpers/dpi';
import { getVectorIntrinsicSize } from '@opengpex/editor/core/helpers/vector';
import { VIEWPORT_FIT_PADDING } from '@opengpex/editor/core/helpers/presets';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';

import * as P from '@opengpex/editor/core/advanced/protocols';

/**
 * FRAME_CREATE_COMMANDS: Handles artboard (Frame) creation, branching, and lifecycle management.
 */
export const FrameCreateCommands = {
  trunk: {
    id: P.ADV_FRAME_TRUNK,
    name: 'Initialize Trunk Frame',
    execute: async (ctx: EditorContextValue, payload: { source: File | string; switchFrame?: boolean; extra?: Record<string, unknown> }): Promise<string> => {
      const { source, switchFrame = true, extra } = payload;
      const { assets, pixels, actions, state, geometry } = ctx;
      let file: File;
      let sourceType: 'local' | 'url' = 'local';

      if (typeof source === 'string') {
        sourceType = 'url';
        file = await actions.withSignal(
          'sys.asset.downloading',
          () => pixels.utils.fetchFromUrl(source)
        );
      } else {
        file = source;
      }

      let safeFile = file;
      const format = pixels.utils.detectFormat(file);

      // Extract EXIF from original file BEFORE transcoding (RAW/HEIC contain rich EXIF that transcoded PNG won't carry)
      const exif = await MetadataHelper.extractExif(file);
      let chosenFrameDpi: number | undefined; // Tracks user-chosen DPI for vector imports

      if (format === 'svg' || format === 'eps') {
        // Vector format: lightweight main-thread size parsing (no Worker/WASM needed)
        const formatLabel = format.toUpperCase();
        const DEFAULT_DPI = 300;
        const MAX_RASTER_DIMENSION = 16384; // Safety limit: prevent OOM on extreme sizes

        let intrinsicSize: { w: number; h: number };
        try {
          intrinsicSize = await getVectorIntrinsicSize(file);
        } catch (err) {
          console.error(`[FrameCreate] Failed to parse ${formatLabel} intrinsic size:`, err);
          actions.notifyHUD(`Failed to parse ${formatLabel} file dimensions. The file may be corrupted.`, 'error');
          return '';
        }

        const allOptions = DPI_PRESETS.map(p => ({
          id: String(p.value),
          label: `${p.value} DPI`,
          description: `${p.label} · ${Math.round(intrinsicSize.w * p.value / 72)}×${Math.round(intrinsicSize.h * p.value / 72)} px`,
          primary: p.value === DEFAULT_DPI,
        }));
        const vectorHelpText = `OpenGPEX is a raster (pixel) image editor and does not support native vector editing for ${formatLabel} files. The file will be rasterized at the selected resolution for pixel-level editing.`;
        const chosenDpi = await actions.askChoice(`${formatLabel} Rasterize Resolution`, allOptions, vectorHelpText);
        if (!chosenDpi) return '';  // User cancelled — silently abort without creating frame
        const dpi = parseInt(chosenDpi, 10) || DEFAULT_DPI;
        chosenFrameDpi = dpi;
        const scale = dpi / 72;
        let targetWidth = Math.round(intrinsicSize.w * scale);
        let targetHeight = Math.round(intrinsicSize.h * scale);

        // Clamp to safety maximum to prevent memory exhaustion
        if (targetWidth > MAX_RASTER_DIMENSION || targetHeight > MAX_RASTER_DIMENSION) {
          const clampRatio = MAX_RASTER_DIMENSION / Math.max(targetWidth, targetHeight);
          targetWidth = Math.round(targetWidth * clampRatio);
          targetHeight = Math.round(targetHeight * clampRatio);
          actions.notifyHUD(`Output clamped to ${targetWidth}×${targetHeight} px (maximum ${MAX_RASTER_DIMENSION} px per side).`, 'info');
        }

        try {
          safeFile = await actions.withSignal(
            'sys.asset.transcoding',
            () => pixels.process.preTranscode(file, { targetWidth, targetHeight, dpi })
          );
        } catch (err) {
          console.error(`[FrameCreate] ${formatLabel} rasterization failed:`, err);
          actions.notifyHUD(`${formatLabel} rasterization failed. Try a lower resolution or check the file.`, 'error');
          return '';
        }
      } else if (format === 'heic' || format === 'raw') {
        safeFile = await actions.withSignal(
          'sys.asset.transcoding',
          () => pixels.process.preTranscode(file)
        );
      }

      // 1. Register original asset
      const assetId = await assets.register(safeFile);
      const assetUrl = assets.getURL(assetId)!;

      // 2. Concurrently execute time-consuming tasks: decode dimensions, decode bounding box, generate thumbnail
      const [dimension, contentBounds, thumbBlob] = await Promise.all([
        pixels.decode.dimensions(assetUrl),
        pixels.decode.contentBounds(assetUrl),
        pixels.process.thumbnail(assetUrl, 256)
      ]);

      // 3. Register thumbnail asset
      const thumbAssetId = await assets.register(thumbBlob);
      const thumbAssetUrl = assets.getURL(thumbAssetId)!;

      // 4. Construct initial environment and camera calculation
      const { insets } = state.ui.theme.config;
      const initialCamera = geometry.camera.getFitCamera(
        state.ui.viewportDim,
        dimension,
        { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right }
      );
      const defaultCanvasCropBox = asLocalShape({ x: dimension.w * 0.25, y: dimension.h * 0.25, w: dimension.w * 0.5, h: dimension.h * 0.5 });

      // 5. Assemble domain entities
      const baseLayer = LayerFactory.getNewLayer({
        name: 'Background',
        src: assetUrl,
        assetId,
        cx: 0,
        cy: 0,
        locked: true, // Background layer is locked by default (like Photoshop)
        bounding: dimension,
        visibleShape: asLocalShape(contentBounds),
        metadata: { format: safeFile.type, size: safeFile.size, source: sourceType, originalName: safeFile.name, exif }
      });

      const expandedLayers = LayerFactory.expandLayers([baseLayer]);

      const frame = LayerFactory.getNewFrame({
        id: `f-${Date.now().toString(36)}-trunk`,
        name: safeFile.name,
        canvas: dimension,
        dpi: chosenFrameDpi || extractDpiFromExif(exif),
        layers: { byId: Object.fromEntries(expandedLayers.map(l => [l.id, l])), order: expandedLayers.map(l => l.id) },
        activeLayerId: baseLayer.id,
        camera: initialCamera,
        canvasCropBox: defaultCanvasCropBox,
        assetId,
        thumbnail: { src: thumbAssetUrl, assetId: thumbAssetId },
        extra
      });

      actions.addFrame(frame, switchFrame);
      return frame.id;
    }
  } as EditorCommand<{ source: File | string; switchFrame?: boolean; extra?: Record<string, unknown> }, Promise<string>>,

  branch: {
    id: P.ADV_FRAME_BRANCH,
    name: 'Create Branch',
    undoable: true,
    execute: async (ctx: EditorContextValue): Promise<string | undefined> => {
      const { activeFrame, actions, state, geometry, pixels } = ctx;
      if (!activeFrame) return;

      // Resolve the active selection from `frame.latestClipTool`.
      // For non-rectangular selections, the branch preserves the selection
      // shape — pixels outside the selection are transparent in the PNG.
      const box = getClipBox(activeFrame);
      if (!box) {
        actions.setInteraction({ hud: { message: 'No active selection — draw a crop box first.', type: 'error' } });
        return;
      }
      const cropRect = box.spatial.rect;

      try {
        // Convert the selection to a LocalShape for shapeToBlob.
        //
        // For polygon selections: we must produce pathData with coordinates
        // RELATIVE to the bounding rect origin, because `mergeLayersWithShape`
        // internally zeros the rect to {0,0,w,h} and shifts layer matrices by
        // (-rect.x, -rect.y). If pathData uses absolute frame-local coords
        // (as `polygonToShape` does), the clip path would be misaligned with
        // the rendered layers. Subtracting poly.rect.x/y from each point
        // ensures the clip aligns with the shifted layer content.
        let branchShape: LocalShape;
        if (!box.regular) {
          const poly = box.spatial;
          const parts: string[] = [];
          for (const ring of poly.rings) {
            if (ring.length < 2) continue;
            const segs: string[] = [];
            for (let i = 0; i < ring.length; i++) {
              const p = ring[i];
              segs.push(`${i === 0 ? 'M' : 'L'} ${p.x - poly.rect.x} ${p.y - poly.rect.y}`);
            }
            segs.push('Z');
            parts.push(segs.join(' '));
          }
          branchShape = {
            type: 'path',
            rect: poly.rect,
            hardEdge: false,
            antiAliased: poly.antiAliased !== false,
            pathData: parts.join(' '),
            __brand: 'local',
          } as LocalShape;
        } else {
          branchShape = box.spatial;
        }

        const highResBlob = await pixels.render.shapeToBlob(
          activeFrame,
          branchShape,
          { format: 'image/png', quality: 1.0 }
        );

        const highResId = await ctx.assets.register(highResBlob as Blob);
        const highResUrl = ctx.assets.getURL(highResId)!;

        const thumbBlob = await pixels.process.thumbnail(highResUrl, 256);
        const thumbId = await ctx.assets.register(thumbBlob);
        const thumbnailUrl = ctx.assets.getURL(thumbId)!;

        const canvasDim = {
          w: Math.round(cropRect.w),
          h: Math.round(cropRect.h)
        };

        const { insets } = state.ui.theme.config;

        const initialCamera = geometry.camera.getFitCamera(
          state.ui.viewportDim,
          canvasDim,
          { maxScale: 1, padding: VIEWPORT_FIT_PADDING, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right }
        );

        const siblings = state.frames.order.map(id => state.frames.byId[id]).filter(f => f.parentId === activeFrame.id);
        const nextIdx = siblings.length + 1;

        let seqNum = '';
        if (!activeFrame.parentId) {
          seqNum = `Branch#${nextIdx}`;
        } else {
          seqNum = `${activeFrame.seqNum || 'Branch#?'}.${nextIdx}`;
        }

        const rootName = activeFrame.name.split('__')[0];
        const fullName = `${rootName}__${seqNum}`;

        // 3. Construct branch artboard (using Domain Factory)
        const baseLayer = ctx.layers.getNewLayer({
          name: 'Branch Base',
          src: highResUrl,
          assetId: highResId,
          locked: true, // Branch base layer is locked by default
          bounding: canvasDim,
          visibleShape: asLocalShape({ x: 0, y: 0, ...canvasDim }),
          ancestor: true
        });

        const expandedLayers = ctx.layers.expandLayers([baseLayer]);

        const branch = ctx.layers.getNewFrame({
          id: `f-${Date.now().toString(36)}-branch`,
          parentId: activeFrame.id,
          name: fullName,
          seqNum: seqNum,
          canvas: canvasDim,
          layers: { byId: Object.fromEntries(expandedLayers.map(l => [l.id, l])), order: expandedLayers.map(l => l.id) },
          activeLayerId: baseLayer.id,
          camera: initialCamera,
          canvasCropBox: asLocalShape({
            x: canvasDim.w * 0.25,
            y: canvasDim.h * 0.25,
            w: canvasDim.w * 0.5,
            h: canvasDim.h * 0.5
          }),
          assetId: highResId,
          thumbnail: {
            src: thumbnailUrl,
            assetId: thumbId,
          },
        });

        ctx.layers.addFrame(branch, false);

        window.dispatchEvent(new CustomEvent('editor:branch-thumbnail-ready', {
          detail: { thumbnailUrl, frameId: branch.id }
        }));

        return thumbnailUrl;
      } catch (err) {
        console.error('[FrameService] Failed to create branch:', err);
      }
    }
  } as EditorCommand<void, Promise<string | undefined>>,

  revert: {
    id: P.ADV_FRAME_REVERT,
    name: 'Revert to Original',
    undoable: false,
    execute: async (ctx: EditorContextValue): Promise<void> => {
      const { geometry, activeFrame, actions, state, assets, pixels } = ctx;
      if (!activeFrame) return;

      const baseLayer = activeFrame.layers.byId[activeFrame.layers.order[0]];
      if (!baseLayer) return;

      const originalAssetId = activeFrame.assetId || baseLayer.assetId;
      if (!originalAssetId) {
        actions.setInteraction({ hud: { message: 'Original asset ID missing.', type: 'error' } });
        return;
      }

      try {
        // 💡 1. Physical layer hydration: ensure the original physical asset is loaded and hydrated into memory
        await assets.hydrate(new Set([originalAssetId]));
        const assetEntry = assets.get(originalAssetId);

        if (!assetEntry || !assetEntry.blob) {
          throw new Error('Original physical asset blob not found in store');
        }

        // 💡 2. Generate a fresh ObjectURL binding to ensure absolute availability
        const liveSrc = assets.resolve(originalAssetId) || URL.createObjectURL(assetEntry.blob);

        // 💡 3. Re-decode dimensions and bounds from the original physical Blob to achieve a true physical "refresh"
        const [dimension, contentBounds] = await Promise.all([
          pixels.decode.dimensions(liveSrc),
          pixels.decode.contentBounds(liveSrc)
        ]);

        const { insets } = state.ui.theme.config;

        // 💡 4. Re-calculate the camera position fitting the viewport
        const newCamera = geometry.camera.getFitCamera(
          state.ui.viewportDim,
          dimension,
          { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right }
        );

        // 💡 5. Fully refresh the artboard's canvas size, camera, crop boxes, and all layers
        // 💡 5. Assemble a minimal base layer, completely clear masks (vectorMasks: []), and reset transform and filters
        const cleanBaseLayer = {
          ...baseLayer,
          assetId: originalAssetId, // Restore to original physical asset ID
          src: liveSrc,           // Refresh to the latest physical Object URL
          bounding: dimension,    // Refresh to the re-decoded original dimensions
          cx: 0,
          cy: 0,
          scale: 1,
          rotation: 0,
          flip: { h: false, v: false },
          adjustments: { brightness: 100, contrast: 100, saturation: 100, hueRotate: 0, blur: 0 },
          visibleShape: asLocalShape(contentBounds), // Re-decoded original bounds
          vectorMasks: [],              // 💡 Completely clear masks!
        };

        // 💡 6. Use LayerFactory to regenerate the cleanest triplet layers, automatically discarding all other redundant layers
        const refreshedLayers = LayerFactory.expandLayers([cleanBaseLayer]);

        const nextOrder = refreshedLayers.map(l => l.id);
        const nextById: Record<string, Layer> = {};
        refreshedLayers.forEach(l => (nextById[l.id] = l));

        // 💡 7. Fully refresh artboard's canvas dimensions, camera, crop boxes, and layer data
        actions.updateFrame(activeFrame.id, {
          canvas: dimension,
          camera: newCamera,
          clipBoxes: {},
          canvasCropBox: asLocalShape({
            x: dimension.w * 0.25,
            y: dimension.h * 0.25,
            w: dimension.w * 0.5,
            h: dimension.h * 0.5
          }),
          layers: { byId: nextById, order: nextOrder },
          activeLayerId: refreshedLayers[0]?.id
        });

        actions.setInteraction({ hud: { message: 'Frame reloaded and reverted to original.', type: 'success' } });
      } catch (err) {
        console.error('[FrameService] True revert reload failed:', err);
        actions.setInteraction({ hud: { message: 'Failed to reload original source.', type: 'error' } });
      }
    }
  } as EditorCommand<void, Promise<void>>,

  export: {
    id: P.ADV_FRAME_EXPORT,
    name: 'Export Frame',
    execute: async (ctx: EditorContextValue, frame: Frame): Promise<{ state: unknown; assets: Record<string, Blob> }> => {
      const { storage } = ctx;
      return storage.export(frame);
    }
  } as EditorCommand<Frame, Promise<{ state: unknown; assets: Record<string, Blob> }>>,

  import: {
    id: P.ADV_FRAME_IMPORT,
    name: 'Import Frame',
    execute: async (ctx: EditorContextValue, payload: {
      state: unknown;
      assetBlobs: Record<string, Blob>;
      replaceId?: string;
      switchFrame?: boolean;
    }): Promise<Frame> => {
      const { assets, storage, actions } = ctx;
      const { state, assetBlobs, replaceId, switchFrame = true } = payload;

      // 1. Inject all assets into AssetService
      for (const [, blob] of Object.entries(assetBlobs)) {
        await assets.register(blob);
      }

      // 2. Hydrate/restore artboard
      const frame = storage.import(state);

      // 3. Add to store (supports add or overwrite mode)
      if (replaceId) {
        actions.resetHistory();
        actions.replaceFrame(replaceId, frame);
      } else {
        actions.addFrame(frame, switchFrame);
      }
      return frame;
    }
  } as EditorCommand<{ state: unknown; assetBlobs: Record<string, Blob>; replaceId?: string; switchFrame?: boolean }, Promise<Frame>>,

  remove: {
    id: P.ADV_FRAME_REMOVE,
    name: 'Delete Creation',
    execute: async (ctx: EditorContextValue, id: string): Promise<void> => {
      const { actions, state } = ctx;
      const targetId = id || state.activeFrameId;
      if (!targetId) return;

      const frame = state.frames.byId[targetId];
      if (!frame) return;

      const confirmed = await actions.askConfirm(
        `Delete "${frame.name}"?`,
        "This action is permanent and cannot be undone. All associated history and assets will be purged.",
        'danger',
        'rect'
      );

      if (confirmed) {
        ctx.layers.removeFrame(targetId);
        // 💡 Architectural optimization: No need to synchronously call sync here.
        // Because actions.removeFrame asynchronously dispatches the REMOVE_FRAME action,
        // and at this time ctx.state still contains the frame that has not yet been deleted. We have wired this logic to the global
        // enhanced dispatcher interceptor (scheduleAssetSync). 2 seconds after REMOVE_FRAME occurs,
        // it will automatically trigger the most precise physical garbage collection (GC) with force=true once the new state stabilizes.
        actions.setInteraction({ hud: { message: 'Creation deleted permanently.', type: 'success' } });
      }
    }
  } as EditorCommand<string, Promise<void>>
};
