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
 * The import flow is decomposed into focused strategy modules:
 *
 *   importers/index.ts   → resolveAndDecode entry point + barrel exports
 *   importers/vector.ts  → SVG/EPS DPI selection dialog (vector-specific)
 *   importers/single.ts  → Standard single-layer frame creation
 *   importers/multi.ts   → Multi-page TIFF / animated GIF import
 *
 * Branch commands:
 *   branchFromFile       → Create branch from external File (reuses importSingleImage)
 *   branchFromSelection  → Create branch from active selection (composite pipeline)
 *
 * Revert is in its own file: revert.ts (independent command, not proxied here).
 */

'use client';

import { EditorCommand, EditorContextValue, Frame, LocalShape } from '@opengpex/editor/core/types';
import { polygonToShape } from '@opengpex/editor/core/helpers/path2d';

import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import * as P from '@opengpex/editor/core/advanced/protocols';
import type { DecodeResult, ImageMetadata } from '@opengpex/editor/core/files/types';

// Strategy imports
import { addFrameFromFile, addFrameFromDecoded } from './importers';

// ═══════════════════════════════════════════════════════════════════════════════
// Shared helper: compute branch naming (seqNum + fullName)
// ═══════════════════════════════════════════════════════════════════════════════

function computeBranchNaming(state: EditorContextValue['state'], activeFrame: Frame): { seqNum: string; fullName: string } {
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

  return { seqNum, fullName };
}

/**
 * FRAME_CREATE_COMMANDS: Handles artboard (Frame) creation, branching, and lifecycle management.
 */
export const FrameCreateCommands = {
  trunk: {
    id: P.ADV_FRAME_TRUNK,
    name: 'Initialize Trunk Frame',
    execute: async (ctx: EditorContextValue, payload: { source: File | string; switchFrame?: boolean; extra?: Record<string, unknown> }): Promise<string> => {
      const { source, switchFrame = true, extra } = payload;
      return addFrameFromFile(ctx, source, { switchFrame, extra });
    },
  } as EditorCommand<{ source: File | string; switchFrame?: boolean; extra?: Record<string, unknown> }, Promise<string>>,

  // ═══════════════════════════════════════════════════════════════════════════
  // Branch Commands: fromFile + fromSelection
  // ═══════════════════════════════════════════════════════════════════════════

  branchFromFile: {
    id: P.ADV_FRAME_BRANCH_FILE,
    name: 'Create Branch from File',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload: { source: File; extra?: Record<string, unknown> }): Promise<string | undefined> => {
      const { activeFrame, state } = ctx;
      if (!activeFrame) return;

      const { source, extra } = payload;

      try {
        const { seqNum, fullName } = computeBranchNaming(state, activeFrame);

        const frameId = await addFrameFromFile(ctx, source, {
          switchFrame: false,
          extra,
          parentId: activeFrame.id,
          seqNum,
          nameOverride: fullName,
        });

        return frameId || undefined;
      } catch (err) {
        console.error('[FrameService] Failed to create branch from file:', err);
        return;
      }
    },
  } as EditorCommand<{ source: File; extra?: Record<string, unknown> }, Promise<string | undefined>>,

  /**
   * branchFromSelection — Create a branch frame from the active selection.
   *
   * Design: Routes through `importSingleImage` (same path as trunk/branchFromFile)
   * to ensure complete metadata inheritance. This guarantees:
   *   - raw.icc profile is preserved (MetadataPanel shows ICC badge)
   *   - camera/capture/dates EXIF fields are inherited
   *   - Color pipeline (colorSpace/trc/bitDepth) is correctly resolved via strategy
   *   - Layer metadata structure is identical to file-imported frames
   *
   * The key difference from file-based import is the "source" — instead of a decoded
   * file, we composite the active frame's visible layers within the selection ROI,
   * then wrap the result as a synthetic DecodeResult with metadata inherited from
   * the parent frame's base layer.
   */
  branchFromSelection: {
    id: P.ADV_FRAME_BRANCH_CROP,
    name: 'Create Branch from Selection',
    undoable: true,
    execute: async (ctx: EditorContextValue): Promise<string | undefined> => {
      const { activeFrame, actions, state, pixels } = ctx;
      if (!activeFrame) return;

      const box = getClipBox(activeFrame);
      if (!box) {
        actions.setInteraction({ hud: { message: 'No active selection — draw a crop box first.', type: 'error' } });
        return;
      }
      const cropRect = box.rect;

      try {
        // ── Step 1: Composite the selection region ───────────────────────────────
        const branchShape: LocalShape = polygonToShape(box);
        const branchResult = await pixels.render.compositeFrame(activeFrame, branchShape);
        const highResBlob = await branchResult.toBlob();

        // ── Step 2: Construct synthetic DecodeResult with inherited metadata ─────
        // Read parent's frame-level metadata to inherit raw.icc / camera / capture / dates,
        // then override composite-specific fields (format, dimensions, bitDepth).
        // importSingleImage will use this metadata for:
        //   - Frame.metadata (drives MetadataPanel display)
        //   - Color pipeline strategy resolution (colorSpace → Frame.colorSpace)
        //   - DPI / bitDepth detection
        const parentImageMetadata = activeFrame.metadata;

        const canvasDim = {
          w: Math.round(cropRect.w),
          h: Math.round(cropRect.h),
        };

        const syntheticDecodeResult: DecodeResult = {
          dimensions: canvasDim,
          metadata: {
            ...(parentImageMetadata || {} as ImageMetadata),
            sourceFormat: 'png',
            sourceFileName: undefined,
            sourceFileSize: highResBlob.size,
            width: canvasDim.w,
            height: canvasDim.h,
            dpi: activeFrame.dpi || parentImageMetadata?.dpi || 72,
            dpiSource: parentImageMetadata?.dpiSource || 'default',
            colorSpace: (activeFrame.colorSpace || 'srgb') as ImageMetadata['colorSpace'],
            bitDepth: 8, // composite output is always 8-bit (Canvas2D limitation)
            hasAlpha: true,
          },
          subImages: [{ displayBlob: highResBlob, width: canvasDim.w, height: canvasDim.h, index: 0 }],
          sourceBlob: undefined, // No 16-bit source (composite is 8-bit; see WebGPU roadmap)
        };

        const { seqNum, fullName } = computeBranchNaming(state, activeFrame);
        const syntheticFile = new File([highResBlob], `${fullName}.png`, { type: 'image/png' });

        // ── Step 3: Delegate to addFrameFromDecoded (unified frame creation) ─────
        const { frameId, thumbnailUrl } = await addFrameFromDecoded(ctx, syntheticDecodeResult, syntheticFile, {
          switchFrame: false,
          parentId: activeFrame.id,
          seqNum,
          nameOverride: fullName,
        });

        // ── Step 4: Emit thumbnail-ready event for fly-in animation ──────────────
        if (thumbnailUrl) {
          window.dispatchEvent(new CustomEvent('editor:branch-thumbnail-ready', {
            detail: { thumbnailUrl, frameId },
          }));
        }

        return thumbnailUrl;
      } catch (err) {
        console.error('[FrameService] Failed to create branch from selection:', err);
      }
    },
  } as EditorCommand<void, Promise<string | undefined>>,

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
        const bmp = await createImageBitmap(blob);
        await assets.register(blob, { w: bmp.width, h: bmp.height });
        bmp.close();
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
