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

/**
 * FRAME_CREATE_COMMANDS — Thin dispatch shell.
 *
 * This module is the entry point for frame (artboard) creation + lifecycle commands.
 * Heavy import logic is delegated to focused strategy modules:
 *
 *   strategies/vectorRaster.ts  → SVG/EPS DPI selection + unified decode
 *   strategies/singleImage.ts   → Standard single-layer frame creation
 *   strategies/multiSubImage.ts → Multi-page TIFF / animated GIF import
 *
 * Revert is in its own file: revert.ts (independent command, not proxied here).
 */

'use client';

import { EditorCommand, EditorContextValue, Frame, LocalShape, asLocalShape } from '@opengpex/editor/core/types';
import { polygonToShape } from '@opengpex/editor/core/helpers/path2d';

import { VIEWPORT_FIT_PADDING } from '@opengpex/editor/core/helpers/presets';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import * as P from '@opengpex/editor/core/advanced/protocols';

// Strategy imports
import { decodeWithVectorDialog } from './strategies/vectorRaster';
import { importSingleImage } from './strategies/singleImage';
import { importMultiSubImage } from './strategies/multiSubImage';

/**
 * FRAME_CREATE_COMMANDS: Handles artboard (Frame) creation, branching, and lifecycle management.
 */
export const FrameCreateCommands = {
  trunk: {
    id: P.ADV_FRAME_TRUNK,
    name: 'Initialize Trunk Frame',
    execute: async (ctx: EditorContextValue, payload: { source: File | string; switchFrame?: boolean; extra?: Record<string, unknown> }): Promise<string> => {
      const { source, switchFrame = true, extra } = payload;

      // 1. Decode with optional vector DPI dialog
      const result = await decodeWithVectorDialog(ctx, source);
      if (!result) return ''; // User cancelled or decode failed

      const { decoded, file, sourceType, chosenFrameDpi } = result;
      const importCtx = { ctx, file, decoded, sourceType, switchFrame, chosenFrameDpi, extra };

      // 2. Route: multi-sub-image or single image
      if (decoded.subImages.length > 1) {
        const multiResult = await importMultiSubImage(importCtx);
        if (multiResult !== null) return multiResult; // Handled (or cancelled with '')
        // null = fall through to single image (TIFF "First Page Only" mode)
      }

      return importSingleImage(importCtx);
    },
  } as EditorCommand<{ source: File | string; switchFrame?: boolean; extra?: Record<string, unknown> }, Promise<string>>,

  branch: {
    id: P.ADV_FRAME_BRANCH,
    name: 'Create Branch',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload?: { source?: File; extra?: Record<string, unknown> }): Promise<string | undefined> => {
      const { activeFrame, actions, state, geometry, pixels } = ctx;
      if (!activeFrame) return;

      // ─── Path A: Create branch from external File source ────────────────
      if (payload?.source) {
        try {
          const result = await decodeWithVectorDialog(ctx, payload.source);
          if (!result) return; // User cancelled or decode failed

          const { decoded } = result;
          const displayBlob = decoded.subImages[0].displayBlob;
          const dimension = decoded.dimensions;

          // Register asset
          const highResId = await ctx.assets.register(displayBlob);
          const highResUrl = ctx.assets.getURL(highResId)!;

          // Generate thumbnail
          const thumbBlob = await pixels.process.thumbnail(highResUrl, 256);
          const thumbId = await ctx.assets.register(thumbBlob);
          const thumbnailUrl = ctx.assets.getURL(thumbId)!;

          const canvasDim = { w: dimension.w, h: dimension.h };
          const { insets } = state.ui.theme.config;

          const initialCamera = geometry.camera.getFitCamera(
            state.ui.viewportDim,
            canvasDim,
            { maxScale: 1, padding: VIEWPORT_FIT_PADDING, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right },
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

          const baseLayer = ctx.layers.getNewLayer({
            name: 'Branch Base',
            src: highResUrl,
            assetId: highResId,
            locked: true,
            bounding: canvasDim,
            visibleShape: asLocalShape({ x: 0, y: 0, ...canvasDim }),
            ancestor: true,
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
              h: canvasDim.h * 0.5,
            }),
            assetId: highResId,
            thumbnail: { src: thumbnailUrl, assetId: thumbId },
            extra: payload.extra,
          });

          ctx.layers.addFrame(branch, false);

          window.dispatchEvent(new CustomEvent('editor:branch-thumbnail-ready', {
            detail: { thumbnailUrl, frameId: branch.id },
          }));

          return branch.id;
        } catch (err) {
          console.error('[FrameService] Failed to create branch from file:', err);
          return;
        }
      }

      // ─── Path B: Create branch from active selection (clip box) ─────────
      const box = getClipBox(activeFrame);
      if (!box) {
        actions.setInteraction({ hud: { message: 'No active selection — draw a crop box first.', type: 'error' } });
        return;
      }
      const cropRect = box.rect;

      try {
        // Convert the LocalPolygon selection to a LocalShape for shapeToBlob.
        // polygonToShape is the canonical serialization entry point: it recognizes
        // rect/circle shapes, writes smooth M/L/Z pathData, and preserves the
        // antiAliased flag so shapeToPath2D can apply Bresenham stair-stepping
        // at render time — ensuring branch respects the AA setting.
        const branchShape: LocalShape = polygonToShape(box);

        const highResBlob = await pixels.render.shapeToBlob(
          activeFrame,
          branchShape,
          { format: 'image/png', quality: 1.0 },
        );

        const highResId = await ctx.assets.register(highResBlob as Blob);
        const highResUrl = ctx.assets.getURL(highResId)!;

        const thumbBlob = await pixels.process.thumbnail(highResUrl, 256);
        const thumbId = await ctx.assets.register(thumbBlob);
        const thumbnailUrl = ctx.assets.getURL(thumbId)!;

        const canvasDim = {
          w: Math.round(cropRect.w),
          h: Math.round(cropRect.h),
        };

        const { insets } = state.ui.theme.config;

        const initialCamera = geometry.camera.getFitCamera(
          state.ui.viewportDim,
          canvasDim,
          { maxScale: 1, padding: VIEWPORT_FIT_PADDING, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right },
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

        // Construct branch artboard (using Domain Factory)
        const baseLayer = ctx.layers.getNewLayer({
          name: 'Branch Base',
          src: highResUrl,
          assetId: highResId,
          locked: true,
          bounding: canvasDim,
          visibleShape: asLocalShape({ x: 0, y: 0, ...canvasDim }),
          ancestor: true,
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
            h: canvasDim.h * 0.5,
          }),
          assetId: highResId,
          thumbnail: {
            src: thumbnailUrl,
            assetId: thumbId,
          },
        });

        ctx.layers.addFrame(branch, false);

        window.dispatchEvent(new CustomEvent('editor:branch-thumbnail-ready', {
          detail: { thumbnailUrl, frameId: branch.id },
        }));

        return thumbnailUrl;
      } catch (err) {
        console.error('[FrameService] Failed to create branch:', err);
      }
    },
  } as EditorCommand<{ source?: File; extra?: Record<string, unknown> } | void, Promise<string | undefined>>,

  // ═══════════════════════════════════════════════════════════════════════════
  // Lifecycle Commands: export / import / remove
  // ═══════════════════════════════════════════════════════════════════════════

  export: {
    id: P.ADV_FRAME_EXPORT,
    name: 'Export Frame',
    execute: async (ctx: EditorContextValue, frame: Frame): Promise<{ state: unknown; assets: Record<string, Blob> }> => {
      const { storage } = ctx;
      return storage.export(frame);
    },
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
    },
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
        'rect',
      );

      if (confirmed) {
        requestAnimationFrame(() => {
          ctx.layers.removeFrame(targetId);
          actions.setInteraction({ hud: { message: 'Creation deleted permanently.', type: 'success' } });
        });
      }

    },
  } as EditorCommand<string, Promise<void>>,
};
