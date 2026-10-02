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
 * Multi-page TIFF Import & Revert Strategy — Trunk + Branch model.
 *
 * A multi-page TIFF is semantically N independent canvases derived from one
 * source file, not N layers inside one canvas. So each page becomes its own
 * frame: page 0 → a trunk frame, pages 1..N-1 → branch frames whose `parentId`
 * points at the trunk (reusing the existing branch mechanism from `create.ts`).
 * The whole group is tagged with a shared `extra.tiffGroupId` (mirrors the
 * `extra.gifSequenceId` grouping in `multi-gif.ts`).
 *
 * Import delegates each page to `importSingleImage` (single.ts). Revert
 * re-decodes the original file once and rebuilds every currently-alive group
 * member in place via the private `rebuildOnePage` helper — deliberately a
 * standalone copy of `revertSingleImage`'s steps 2-5 rather than a shared
 * extraction, keeping `single.ts` untouched (see design §4.2).
 */

'use client';

import { asLocalShape, EditorContextValue } from '@opengpex/editor/core/types';
import { getDefaultCanvasClipBox } from '@opengpex/editor/core/helpers/selection';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { presets } from '@opengpex/editor/core/helpers/preferences';
const VIEWPORT_FIT_PADDING = presets.get('VIEWPORT_FIT_PADDING');
import type { DecodeResult, DecodedImage, ImageMetadata } from '@opengpex/editor/core/files/types';
import type { ImportOptions } from './_types';
import { importSingleImage } from './single';
import { newMultiPageGroupId } from '../_naming';

// ═══════════════════════════════════════════════════════════════════════════════
// importMultiPageTiff — Trunk + Branch import (no dialog, always this model)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Import a multi-page TIFF as one trunk frame (page 0) plus one branch frame
 * per remaining page, all tagged with a shared `tiffGroupId`.
 *
 * @param ctx - Editor context
 * @param decoded - Decode result: { metadata, pages, sourceBlob }
 * @param file - Resolved source file (frame naming + storeBundle raw source)
 * @param opts - Import options, with `dpi` already finalized
 * @returns Frame ID of the trunk frame.
 */
export async function importMultiPageTiff(
  ctx: EditorContextValue,
  decoded: DecodeResult,
  file: File,
  opts: ImportOptions,
): Promise<string> {
  const { metadata, sourceBlob, pages } = decoded;
  const pageCount = pages.length;
  const tiffGroupId = newMultiPageGroupId('tiff');

  // Page 0 → trunk frame
  const trunkDecoded: DecodeResult = { metadata, pages: [pages[0]], sourceBlob };
  const { frameId: trunkId } = await importSingleImage(ctx, file, trunkDecoded, {
    ...opts,
    extra: { ...opts.extra, tiffGroupId, tiffPageIndex: 0, tiffPageCount: pageCount },
  });

  // Pages 1..N-1 → branch frames, parentId pointing at the trunk.
  // Manual `Branch#i` numbering (total page count is known up front) is
  // semantically equivalent to `newBranchName` without the live sibling count.
  const trunkFrame = ctx.state.frames.byId[trunkId];
  const rootName = (trunkFrame?.name || file.name).split('__')[0];
  for (let i = 1; i < pageCount; i++) {
    const seqNum = `Branch#${i}`;
    const pageDecoded: DecodeResult = { metadata, pages: [pages[i]], sourceBlob };
    // Sequential await, not Promise.all: `actions.addFrame` mutates shared store
    // state, so concurrent creation would race (mirrors branchFromFile).
    await importSingleImage(ctx, file, pageDecoded, {
      switchFrame: false,
      parentId: trunkId,
      seqNum,
      nameOverride: `${rootName}__${seqNum}`,
      extra: { tiffGroupId, tiffPageIndex: i, tiffPageCount: pageCount },
    });
  }

  ctx.actions.notifyHUD(
    `Imported ${pageCount}-page TIFF as 1 trunk + ${pageCount - 1} branch frame(s)`,
    'success',
  );
  return trunkId;
}

// ═══════════════════════════════════════════════════════════════════════════════
// revertMultiPageTiffGroup — Re-decode the original file, rebuild every alive member
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Rebuild `frameId`'s layers/camera/metadata from one re-decoded page and commit
 * in-place. Deliberately duplicates `revertSingleImage`'s steps 2-5 (single.ts)
 * rather than sharing them — see design §4.2 (single.ts stays at zero change).
 *
 * NOTE: does NOT reset history or set the HUD. It runs inside the group loop of
 * `revertMultiPageTiffGroup`, which owns the single history reset + HUD message
 * once for the whole group.
 */
async function rebuildOnePage(
  ctx: EditorContextValue,
  frameId: string,
  page: DecodedImage,
  metadata: ImageMetadata,
  sourceBlob: Blob | null | undefined,
): Promise<void> {
  const { actions, assets, state, geometry } = ctx;

  // 1. Ingest: register display asset + store raw source (raw: dedups by hash
  //    across every page, see importSingleImage / AssetService.storeBundle).
  const bundle = await assets.storeBundle(page, sourceBlob ?? undefined);

  // 2. Resolve content bounds (precomputed during file decode)
  const contentBounds = page.contentBounds ?? { x: 0, y: 0, w: page.width, h: page.height };

  // 3. Camera calculation
  const { insets } = state.ui.theme.config;
  const camera = geometry.camera.getFitCamera(
    state.ui.viewportDim,
    { w: page.width, h: page.height },
    { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right },
  );
  const canvasClipBox = getDefaultCanvasClipBox({ w: page.width, h: page.height });

  // 4. Assemble base layer
  const baseLayer = LayerFactory.getNewLayer({
    name: 'Background',
    src: bundle.url,
    assetId: bundle.assetId,
    cx: 0,
    cy: 0,
    locked: true,
    bounding: { w: page.width, h: page.height },
    visibleShape: asLocalShape(contentBounds),
  });
  const expandedLayers = LayerFactory.expandLayers([baseLayer]);

  // 5. Commit in-place (no history reset / HUD — owned by the outer loop)
  actions.updateFrame(frameId, {
    layers: { byId: Object.fromEntries(expandedLayers.map(l => [l.id, l])), order: expandedLayers.map(l => l.id) },
    activeLayerId: baseLayer.id,
    canvas: { w: page.width, h: page.height },
    camera,
    canvasClipBox,
    metadata,
    clipBoxes: {},
  });
}

/**
 * Revert an entire multi-page TIFF group: re-decode the original file once (via
 * the trunk's assetId), then rebuild every currently-alive group member from its
 * own `tiffPageIndex` page. Does NOT resurrect deleted branches and does NOT
 * add/remove frames when the page count changes (same source, page count is
 * constant) — the post-revert structure is "trunk + whichever branches were
 * still alive", not the original full page set.
 *
 * @returns true if reverted successfully, false otherwise.
 */
export async function revertMultiPageTiffGroup(ctx: EditorContextValue, frameId: string): Promise<boolean> {
  const { actions, state, files } = ctx;
  const frame = state.frames.byId[frameId];
  const groupId = (frame?.extra as Record<string, unknown> | undefined)?.tiffGroupId as string | undefined;
  if (!frame || !groupId) return false;

  // Enumerate the currently-alive members of this group (may be fewer than the
  // original page count if the user deleted a branch).
  const groupFrames = state.frames.order
    .map(id => state.frames.byId[id])
    .filter(f => (f.extra as Record<string, unknown> | undefined)?.tiffGroupId === groupId);
  if (groupFrames.length === 0) return false;

  const trunkFrame = groupFrames.find(f => (f.extra as Record<string, unknown>)?.tiffPageIndex === 0);
  if (!trunkFrame?.assetId) return false;

  try {
    const originalFileName = trunkFrame.source || trunkFrame.name || 'image.tiff';
    const decoded = await files.decodeAsset(trunkFrame.assetId, originalFileName, {
      forcedWidth: trunkFrame.canvas.w,
      forcedHeight: trunkFrame.canvas.h,
      forcedDpi: trunkFrame.dpi,
    });
    if (!decoded) throw new Error('Original TIFF asset not found in store');

    for (const f of groupFrames) {
      const pageIndex = (f.extra as Record<string, unknown>).tiffPageIndex as number;
      const page = decoded.pages[pageIndex];
      if (!page) continue; // page count mismatch (should not happen — same source)
      await rebuildOnePage(ctx, f.id, page, decoded.metadata, decoded.sourceBlob);
    }

    actions.resetHistory();
    actions.setInteraction({ hud: { message: `Reverted ${groupFrames.length} frame(s) to original.`, type: 'success' } });
    return true;
  } catch (err) {
    console.error('[FrameService] Multi-page TIFF group revert failed:', err);
    actions.setInteraction({ hud: { message: 'Failed to revert. Original asset may be missing.', type: 'error' } });
    return false;
  }
}
