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
 * Pack/unpack is in its own file: pack.ts (independent command, not proxied here).
 * Remove is in its own file: remove.ts (independent command, not proxied here).
 */

'use client';

import { EditorCommand, EditorContextValue, LocalShape, asLocalShape } from '@opengpex/editor/core/types';
import { polygonToShape } from '@opengpex/editor/core/geometry/operators/polygon';

import { getClipBox, getDefaultCanvasClipBox } from '@opengpex/editor/core/helpers/selection';
import { newBranchName, newBranchSourceFileName, newFrameId } from './_naming';
import * as P from '@opengpex/editor/core/advanced/protocols';
import type { ImageMetadata } from '@opengpex/editor/core/files/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { transcodeBlob } from '@opengpex/editor/core/engine/utils/pixel-utils';
import { presets } from '@opengpex/editor/core/helpers/preferences';
const VIEWPORT_FIT_PADDING = presets.get('VIEWPORT_FIT_PADDING');

// Strategy imports
import { createFrameFromFile } from './importers';

/**
 * FRAME_CREATE_COMMANDS: Handles artboard (Frame) creation, branching, and lifecycle management.
 */
export const FrameCreateCommands = {
  trunk: {
    id: P.ADV_FRAME_TRUNK,
    name: 'Initialize Trunk Frame',
    execute: async (ctx: EditorContextValue, payload: { source: File | string; switchFrame?: boolean; extra?: Record<string, unknown> }): Promise<string> => {
      const { source, switchFrame = true, extra } = payload;
      const { frameId } = await createFrameFromFile(ctx, source, { switchFrame, extra });
      return frameId;
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
        const { seqNum, fullName } = newBranchName(activeFrame, state.frames);

        const { frameId } = await createFrameFromFile(ctx, source, {
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
   * Composites the selection ROI straight into a `CompositedImage` (self-adaptive
   * bit depth/gamut, §2.4) and assembles the new frame natively from that plain
   * data — no synthetic `DecodeResult`/`File` round-trip through `files.decodeBlob`
   * any more. Metadata assembly mirrors `importSingleImage` for parity:
   *   - raw.icc is inherited from the parent, dropped only if the bake landed in a
   *     different gamut than the parent's (an adobe-rgb/prophoto parent bakes down
   *     to the document's working gamut — carrying its ICC forward would mislabel
   *     the baked pixels);
   *   - EXIF/camera/capture/dates are inherited from the parent frame's metadata;
   *   - bitDepth is the real value carried by `composited.colorIdentity`, no longer
   *     forced to 8.
   */
  branchFromSelection: {
    id: P.ADV_FRAME_BRANCH_CROP,
    name: 'Create Branch from Selection',
    undoable: true,
    execute: async (ctx: EditorContextValue): Promise<string | undefined> => {
      const { activeFrame, actions, state, pixels, assets, geometry } = ctx;
      if (!activeFrame) return;

      const box = getClipBox(activeFrame);
      if (!box) {
        actions.setInteraction({ hud: { message: 'No active selection — draw a clip box first.', type: 'error' } });
        return;
      }

      try {
        // ── Step 1: Composite the selection region — self-adaptive bit depth
        // and source gamut, no options.precision/dpr interference (§2.4) ──────
        const branchShape: LocalShape = polygonToShape(box);
        const composited = await pixels.render.compositeFrame(activeFrame, branchShape);

        // ── Step 2: Golden Path ingest — display + high-depth naked pixels
        // persisted together in one call (§2.3) ──────────────────────────────
        const bundle = await assets.storeBundle(composited);

        // ── Step 3: Assemble the new frame's authoritative metadata ─────────
        const parentImageMetadata = activeFrame.metadata;
        const bakedColorSpace = composited.colorIdentity.gamut as ImageMetadata['colorSpace'];

        // The inherited ICC describes the PARENT's gamut, and is only still valid if
        // the bake landed in that same gamut. Drop it otherwise and let export embed
        // the stock profile for `bakedColorSpace`.
        const inheritedRaw = parentImageMetadata?.raw;
        const raw =
          inheritedRaw && parentImageMetadata?.colorSpace !== bakedColorSpace
            ? { ...inheritedRaw, icc: undefined }
            : inheritedRaw;

        // Computed early (normally a Step 5 concern) because `sourceFileName`
        // below needs `fullName` as its no-parent-file fallback.
        const { seqNum, fullName } = newBranchName(activeFrame, state.frames);

        const frameMetadata: ImageMetadata = {
          ...(parentImageMetadata || {} as ImageMetadata),
          ...(raw ? { raw } : {}),
          // No raw source file backs a composite bake (`storeBundle` never writes
          // a `raw:` blob for it) — but it is still the SAME document lineage, so
          // inherit the parent's format rather than lying that this is a 'png'
          // import (a tiff-sourced document branched from selection stays 'tiff').
          sourceFormat: parentImageMetadata?.sourceFormat || 'unknown',
          sourceFileName: newBranchSourceFileName(fullName, parentImageMetadata?.sourceFileName),
          sourceFileSize: composited.displayBlob.size,
          width: composited.width,
          height: composited.height,
          dpi: activeFrame.dpi || parentImageMetadata?.dpi || 72,
          dpiSource: parentImageMetadata?.dpiSource || 'default',
          colorSpace: bakedColorSpace,
          bitDepth: composited.colorIdentity.bitDepth, // real depth inherited (16 or 8), no forced 8
          hasAlpha: true,
        };

        // ── Step 4: Generate thumbnail (bounds pre-aligned to composite region) ───
        const thumbResult = await pixels.image.resample(bundle.url, { maxSize: 512 });
        const thumbBlob = await transcodeBlob(thumbResult.displayBlob, 'image/webp');
        const { assetId: thumbAssetId, url: thumbAssetUrl } = await assets.register(thumbBlob, {
          width: thumbResult.width,
          height: thumbResult.height,
        });
        const contentBounds = { x: 0, y: 0, w: composited.width, h: composited.height };

        // ── Step 5: Camera + base layer + new frame assembly ────────────────
        const { insets } = state.ui.theme.config;
        const camera = geometry.camera.getFitCamera(
          state.ui.viewportDim,
          { w: composited.width, h: composited.height },
          { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right },
        );
        const canvasClipBox = getDefaultCanvasClipBox({ w: composited.width, h: composited.height });

        const baseLayer = LayerFactory.getNewLayer({
          name: 'Background',
          src: bundle.url,
          assetId: bundle.assetId,
          cx: 0,
          cy: 0,
          locked: true,
          bounding: { w: composited.width, h: composited.height },
          visibleShape: asLocalShape(contentBounds), // aligned with single.ts: record the real visible-content outline
        });
        const expandedLayers = LayerFactory.expandLayers([baseLayer]);

        const newFrame = LayerFactory.getNewFrame({
          id: newFrameId(true),
          parentId: activeFrame.id,
          seqNum,
          name: fullName,
          source: fullName,
          layers: { byId: Object.fromEntries(expandedLayers.map(l => [l.id, l])), order: expandedLayers.map(l => l.id) },
          activeLayerId: baseLayer.id,
          canvas: { w: composited.width, h: composited.height },
          camera,
          canvasClipBox,
          assetId: bundle.assetId,
          thumbnail: { src: thumbAssetUrl, assetId: thumbAssetId },
          dpi: frameMetadata.dpi,
          metadata: frameMetadata,
        });

        // ── Step 6: Commit + emit thumbnail-ready event for fly-in animation ─
        actions.addFrame(newFrame, false);
        window.dispatchEvent(new CustomEvent('editor:branch-thumbnail-ready', {
          detail: { thumbnailUrl: thumbAssetUrl, frameId: newFrame.id },
        }));

        return thumbAssetUrl;
      } catch (err) {
        console.error('[FrameService] Failed to create branch from selection:', err);
      }
    },
  } as EditorCommand<void, Promise<string | undefined>>,
};
