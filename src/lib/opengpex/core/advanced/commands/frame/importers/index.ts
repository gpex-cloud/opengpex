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
 * Frame Importers — Barrel module for file import pipeline.
 *
 * Public API:
 *   - resolveAndDecode(ctx, source) → DecodeOutput | null
 *   - importSingleImage(ctx, decoded, file, sourceType, opts)
 *   - importMultiSubImage(ctx, decoded, file, sourceType, opts)
 *
 * Internal pipeline (encapsulated in resolveAndDecode):
 *   1. Resolve source (File | URL) → File
 *   2. Detect format
 *   3. If vector → prompt DPI dialog (vector.ts)
 *   4. Decode via FileService
 */

'use client';

import type { EditorContextValue } from '@opengpex/editor/core/types';
import type { DecodeResult } from '@opengpex/editor/core/files/types';
import { detectFormat } from '@opengpex/editor/core/files';
import { assetStore } from '@opengpex/editor/core/storage/asset/AssetStore';
import type { DecodeOutput } from './_types';
import { isVectorFormat, promptVectorDpi } from './vector';

export type { DecodeOutput, ImportOptions, ImportingSignalValue } from './_types';
export { SIGNAL_IMPORTING } from './_types';

// ═══════════════════════════════════════════════════════════════════════════════
// resolveAndDecode — Canonical entry point
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolves source, handles vector DPI dialog, and decodes — all in one call.
 *
 * This is the single entry point for "File/URL → DecodeResult" used by
 * both trunk and branch commands. Returns null if user cancelled or decode failed.
 */
export async function resolveAndDecode(
  ctx: EditorContextValue,
  source: File | string,
): Promise<DecodeOutput | null> {
  // 1. Resolve source to File
  let file: File;
  let sourceType: 'local' | 'url' = 'local';

  if (typeof source === 'string') {
    sourceType = 'url';
    file = await ctx.pixels.utils.fetchFromUrl(source);
  } else {
    file = source;
  }

  // 2. Detect format
  const format = detectFormat(file);

  // 3. Vector DPI dialog (SVG/EPS only)
  let decodeOptions: { dpi?: number; targetWidth?: number; targetHeight?: number } | undefined;
  let chosenDpi: number | undefined;

  if (isVectorFormat(format)) {
    const vectorOpts = await promptVectorDpi(ctx, file, format);
    if (!vectorOpts) return null; // User cancelled
    decodeOptions = vectorOpts;
    chosenDpi = vectorOpts.dpi;
  }

  // 4. Decode
  const { actions, files } = ctx;
  let decoded: DecodeResult;
  try {
    decoded = await files.decode(file, decodeOptions);
  } catch (err) {
    console.error(`[FrameCreate] File decode failed:`, err);
    actions.notifyHUD(`Failed to process file. The format may not be supported.`, 'error');
    return null;
  }

  return { decoded, file, sourceType, chosenDpi };
}

// ═══════════════════════════════════════════════════════════════════════════════
// addFrameFromFile — Unified "File → Frame" pipeline
// ═══════════════════════════════════════════════════════════════════════════════

import type { ImportOptions } from './_types';
import { importSingleImage, buildFrameContent } from './single';
import { importAnimatedGif } from './multi-gif';
import { importMultiPageTiff } from './multi-tiff';

/**
 * addFrameFromFile — The single entry point for "File/URL → new Frame in store".
 *
 * Encapsulates: resolveAndDecode + multi-page routing + importSingleImage.
 * Both trunk and branchFromFile delegate to this function, differing only in opts.
 *
 * @param ctx - Editor context
 * @param source - File object or URL string
 * @param opts - Import options (switchFrame, parentId, seqNum, nameOverride, extra, dpi)
 * @returns Frame ID of the created frame, or empty string if user cancelled / decode failed.
 */
export async function addFrameFromFile(
  ctx: EditorContextValue,
  source: File | string,
  opts: ImportOptions,
): Promise<string> {
  // 1. Resolve + vector dialog + decode
  const result = await resolveAndDecode(ctx, source);
  if (!result) return '';

  const { decoded, file, sourceType, chosenDpi } = result;
  const finalOpts: ImportOptions = { ...opts, dpi: opts.dpi ?? chosenDpi };

  // 2. Route: multi-sub-image (GIF / TIFF) or single image
  if (decoded.subImages.length > 1) {
    let multiResult: string | null;
    if (decoded.subImages[0].delay != null) {
      // Animated GIF/APNG
      multiResult = await importAnimatedGif(ctx, decoded, file, sourceType, finalOpts);
    } else {
      // Multi-page TIFF
      multiResult = await importMultiPageTiff(ctx, decoded, file, finalOpts);
    }
    if (multiResult !== null) return multiResult;
    // null = fall through to single image (TIFF "First Page Only" mode)
  }

  const { frameId } = await importSingleImage(ctx, decoded, file, finalOpts);
  return frameId;
}

// ═══════════════════════════════════════════════════════════════════════════════
// addFrameFromDecoded — Create a new frame from pre-decoded data
// (used by branchFromSelection which already has decoded content)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * addFrameFromDecoded — Creates a new frame from an already-decoded result.
 *
 * Unlike `addFrameFromFile` which starts from a File/URL (and runs resolveAndDecode),
 * this function accepts a pre-built DecodeResult. Used by branchFromSelection
 * which composites the selection region and wraps it as a synthetic DecodeResult.
 *
 * @param ctx - Editor context
 * @param decoded - Pre-built DecodeResult (e.g. from composite)
 * @param file - Synthetic File object (for naming/metadata)
 * @param opts - Import options (switchFrame, parentId, seqNum, nameOverride, extra)
 * @returns { frameId, thumbnailUrl }
 */
export async function addFrameFromDecoded(
  ctx: EditorContextValue,
  decoded: import('@opengpex/editor/core/files/types').DecodeResult,
  file: File,
  opts: ImportOptions,
): Promise<{ frameId: string; thumbnailUrl: string }> {
  return importSingleImage(ctx, decoded, file, opts);
}

// ═══════════════════════════════════════════════════════════════════════════════
// revertFrame — In-place rebuild from original blob (counterpart to addFrameFromFile)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * revertFrame — Rebuilds a frame's content from its original asset blob.
 *
 * Counterpart to `addFrameFromFile`:
 * - addFrameFromFile: File/URL → decode → buildFrameContent → addFrame (new frame)
 * - revertFrame: frame.assetId → hydrate → decode → buildFrameContent → updateFrame (in-place)
 *
 * @param ctx - Editor context
 * @param frameId - ID of the frame to revert (must have frame.assetId)
 * @returns true if reverted successfully, false otherwise
 */
export async function revertFrame(ctx: EditorContextValue, frameId: string): Promise<boolean> {
  const { assets, actions, state, files } = ctx;
  const frame = state.frames.byId[frameId];
  if (!frame) return false;

  const originalAssetId = frame.assetId;
  if (!originalAssetId) {
    actions.setInteraction({ hud: { message: 'Original asset ID missing — cannot revert.', type: 'error' } });
    return false;
  }

  try {
    // 1. Hydrate the original asset blob from IndexedDB
    // Try raw source first (16-bit TIFF/PNG stored via storeRaw under `raw:${id}`),
    // then fall back to regular asset (8-bit files where the display blob IS the original).
    let originalBlob: Blob | null = null;
    const rawBlob = await assetStore.getRaw(originalAssetId);
    if (rawBlob) {
      originalBlob = rawBlob;
    } else {
      await assets.hydrate(new Set([originalAssetId]));
      const assetEntry = assets.get(originalAssetId);
      originalBlob = assetEntry?.blob ?? null;
    }
    if (!originalBlob) {
      throw new Error(`Original physical asset blob not found in store (assetId=${originalAssetId})`);
    }

    // 2. Reconstruct File from blob
    const originalFileName = frame.source || frame.name || 'image.png';
    const originalFile = new File([originalBlob], originalFileName, { type: originalBlob.type });

    // 3. Full decode + rebuild via shared buildFrameContent
    const decoded = await files.decode(originalFile);
    const content = await buildFrameContent(ctx, decoded);

    // 4. Update frame in-place (preserves frame ID and list position)
    actions.updateFrame(frameId, {
      canvas: content.canvas,
      camera: content.camera,
      clipBoxes: {},
      canvasClipBox: content.canvasClipBox,
      layers: content.layers,
      activeLayerId: content.activeLayerId,
      metadata: content.metadata,
    });

    // 5. Clear undo/redo history
    actions.resetHistory();
    actions.setInteraction({ hud: { message: 'Reverted to original — all edits discarded.', type: 'success' } });
    return true;
  } catch (err) {
    console.error('[FrameService] Standard revert failed:', err);
    actions.setInteraction({ hud: { message: 'Failed to revert. Original asset may be missing.', type: 'error' } });
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// revertGifFrame — In-place GIF rebuild (uses shared buildGifFrameContent)
// ═══════════════════════════════════════════════════════════════════════════════

import { buildGifFrameContent } from './multi-gif';

/**
 * revertGifFrame — Re-decodes original GIF and rebuilds frame layers in-place.
 *
 * Uses the same `buildGifFrameContent` as GIF import — unified frame count dialog,
 * decimation logic, and layer construction. Only the final step differs:
 * import → addFrame, revert → updateFrame.
 */
export async function revertGifFrame(ctx: EditorContextValue, frameId: string): Promise<boolean> {
  const { assets, actions, state, files } = ctx;
  const frame = state.frames.byId[frameId];
  if (!frame) return false;

  const originalGifAssetId = frame.assetId;
  if (!originalGifAssetId) return false;

  try {
    // 1. Hydrate the original GIF binary from asset store
    await assets.hydrate(new Set([originalGifAssetId]));
    const gifEntry = assets.get(originalGifAssetId);
    if (!gifEntry || !gifEntry.blob) {
      throw new Error('Original GIF asset not found in store');
    }

    // 2. Reconstruct File and decode
    const originalName = frame.source || frame.name + '.gif';
    const gifFile = new File([gifEntry.blob], originalName, { type: 'image/gif' });
    const decoded = await files.decode(gifFile);

    if (!decoded.subImages || decoded.subImages.length <= 1 || decoded.subImages[0].delay == null) {
      throw new Error('Re-decoded GIF has no animation frames');
    }

    // 3. Build GIF content (shared with import — includes frame count dialog)
    const content = await buildGifFrameContent(ctx, decoded);
    if (!content) return false; // User cancelled

    // 4. Update frame in-place
    actions.updateFrame(frameId, {
      canvas: content.canvas,
      camera: content.camera,
      clipBoxes: {},
      canvasClipBox: content.canvasClipBox,
      layers: content.layers,
      activeLayerId: content.activeLayerId,
      extra: { ...(frame.extra as Record<string, unknown>), gifSequenceId: content.gifSequenceId, gifFrameCount: content.gifFrameCount },
      metadata: content.metadata,
    });

    actions.resetHistory();
    actions.setInteraction({ hud: { message: `GIF reverted: ${content.gifFrameCount} frames restored.`, type: 'success' } });
    return true;
  } catch (err) {
    console.error('[FrameService] GIF revert failed:', err);
    actions.setInteraction({ hud: { message: 'Failed to revert GIF. See console for details.', type: 'error' } });
    return false;
  }
}
