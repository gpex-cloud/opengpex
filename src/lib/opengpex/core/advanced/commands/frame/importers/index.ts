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
 *   - createFrameFromFile(ctx, source, opts) → { frameId, thumbnailUrl }
 *   - revertFrame / revertGifFrame(ctx, frameId) → boolean
 *
 * Internal pipeline (encapsulated in resolveAndDecode, not exported):
 *   1. Resolve source (File | URL) → File
 *   2. If rasterizable vector → prompt DPI dialog (vector.ts)
 *   3. Decode via FileService
 */

'use client';

import type { EditorContextValue } from '@opengpex/editor/core/types';
import type { DecodeResult, DecodeOptions } from '@opengpex/editor/core/files/types';
import { toFile, needsRasterSize, classifyDecode } from '@opengpex/editor/core/files';
import type { ImportOptions } from './_types';
import { promptVectorDpi } from './vector';

export type { ImportOptions, ImportingSignalValue } from './_types';
export { SIGNAL_IMPORTING } from './_types';

// ═══════════════════════════════════════════════════════════════════════════════
// resolveAndDecode — Internal entry point (no external callers; kept private)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolves source, handles vector DPI dialog, and decodes — all in one call.
 *
 * Internal helper for `createFrameFromFile`. Knows nothing about `ImportOptions` —
 * `dpi` here is only the vector-dialog choice (if any); merging it with caller
 * opts is `createFrameFromFile`'s job. Returns null if user cancelled or decode failed.
 */
async function resolveAndDecode(
  ctx: EditorContextValue,
  source: File | string,
): Promise<{ file: File; decoded: DecodeResult; vectorDpi?: number } | null> {
  // 1. Resolve source to File
  const file = await toFile(source);

  // 2. Vector DPI dialog (SVG/EPS only)
  let decodeOptions: DecodeOptions | undefined;
  let vectorDpi: number | undefined;

  if (needsRasterSize(file)) {
    const vectorOpts = await promptVectorDpi(ctx, file);
    if (!vectorOpts) return null; // User cancelled
    decodeOptions = {
      forcedDpi: vectorOpts.dpi,
      forcedWidth: vectorOpts.targetWidth,
      forcedHeight: vectorOpts.targetHeight,
    };
    vectorDpi = vectorOpts.dpi;
  }

  // 3. Decode
  const { actions, files } = ctx;
  let decoded: DecodeResult;
  try {
    decoded = await files.decode(file, decodeOptions);
  } catch (err) {
    console.error(`[FrameCreate] File decode failed:`, err);
    actions.notifyHUD(`Failed to process file. The format may not be supported.`, 'error');
    return null;
  }

  return { file, decoded, vectorDpi };
}

// ═══════════════════════════════════════════════════════════════════════════════
// createFrameFromFile — Unified "File → Frame" pipeline
// ═══════════════════════════════════════════════════════════════════════════════

import { importSingleImage, revertSingleImage } from './single';
import { importAnimatedGif } from './multi-gif';
import { importMultiPageTiff, revertMultiPageTiffGroup } from './multi-tiff';

export { revertMultiPageTiffGroup };

/**
 * createFrameFromFile — The single entry point for "File/URL → new Frame in store".
 *
 * Encapsulates: resolveAndDecode + multi-page routing + importSingleImage.
 * Both trunk and branchFromFile delegate to this function, differing only in opts.
 *
 * @param ctx - Editor context
 * @param source - File object or URL string
 * @param opts - Import options (switchFrame, parentId, seqNum, nameOverride, dpi)
 * @returns { frameId, thumbnailUrl } — frameId is '' if user cancelled / decode failed.
 *          The gif/tiff branches (single-image path not taken) don't produce a
 *          thumbnail yet, so thumbnailUrl is '' for those.
 */
export async function createFrameFromFile(
  ctx: EditorContextValue,
  source: File | string,
  opts: ImportOptions,
): Promise<{ frameId: string; thumbnailUrl: string }> {
  // 1. Resolve + vector dialog + decode
  const resolved = await resolveAndDecode(ctx, source);
  if (!resolved) return { frameId: '', thumbnailUrl: '' };

  // 2. Finalize dpi once (vector-dialog choice, unless caller already forced one)
  const { file, decoded, vectorDpi } = resolved;
  const finalOpts: ImportOptions = { ...opts, dpi: opts.dpi ?? vectorDpi };

  // 3. Route: multi-sub-image (GIF / TIFF) or single image
  switch (classifyDecode(decoded)) {
    case 'animated': {
      const frameId = await importAnimatedGif(ctx, decoded, file, finalOpts);
      return { frameId, thumbnailUrl: '' };
    }
    case 'multipage': {
      const frameId = await importMultiPageTiff(ctx, decoded, file, finalOpts);
      return { frameId, thumbnailUrl: '' };
    }
    default:
      break;
  }

  return importSingleImage(ctx, file, decoded, finalOpts);
}


// ═══════════════════════════════════════════════════════════════════════════════
// revertFrame — In-place rebuild from original blob (counterpart to createFrameFromFile)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * revertFrame — Rebuilds a frame's content from its original asset blob.
 *
 * Counterpart to `createFrameFromFile`:
 * - createFrameFromFile: File/URL → decode → importSingleImage (addFrame)
 * - revertFrame: frame.assetId → hydrate → decode → revertSingleImage (updateFrame, in-place)
 *
 * @param ctx - Editor context
 * @param frameId - ID of the frame to revert (must have frame.assetId)
 * @returns true if reverted successfully, false otherwise
 */
export async function revertFrame(ctx: EditorContextValue, frameId: string): Promise<boolean> {
  const { actions, state, files } = ctx;
  const frame = state.frames.byId[frameId];
  if (!frame) return false;

  const originalAssetId = frame.assetId;
  if (!originalAssetId) {
    actions.setInteraction({ hud: { message: 'Original asset ID missing — cannot revert.', type: 'error' } });
    return false;
  }

  // 1. Cold-recover original bytes + decode (raw-first, hydrate fallback).
  //    Pin the decode to the frame's ORIGINAL canvas size + dpi: once retainSourceBlob
  //    widened (§9.3), a vector source (SVG/EPS) now hits the raw-first branch and
  //    would otherwise re-rasterize at its intrinsic size (VectorHandler.decode uses
  //    `options?.forcedWidth || intrinsicSize.w`), silently changing the canvas
  //    resolution on revert. frame.canvas.{w,h}/frame.dpi hold the user's original
  //    choice, so forwarding them keeps revert dimensionally faithful (§9.4).
  const originalFileName = frame.source || frame.name || 'image.png';
  let decoded: DecodeResult | null = null;
  try {
    decoded = await files.decodeAsset(originalAssetId, originalFileName, {
      forcedWidth: frame.canvas.w,
      forcedHeight: frame.canvas.h,
      forcedDpi: frame.dpi,
    });
  } catch (err) {
    console.error(`[FrameService] Revert decode failed (assetId=${originalAssetId}):`, err);
  }
  if (!decoded) {
    actions.setInteraction({ hud: { message: 'Failed to revert. Original asset may be missing.', type: 'error' } });
    return false;
  }

  // 2. Rebuild + commit via shared revertSingleImage (mirrors importSingleImage's addFrame)
  return revertSingleImage(ctx, frameId, decoded);
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
  const { actions, state, files } = ctx;
  const frame = state.frames.byId[frameId];
  if (!frame) return false;

  const originalGifAssetId = frame.assetId;
  if (!originalGifAssetId) return false;

  try {
    // 1. Cold-recover original GIF bytes + decode
    const originalName = frame.source || frame.name + '.gif';
    const decoded = await files.decodeAsset(originalGifAssetId, originalName);
    if (!decoded) {
      throw new Error('Original GIF asset not found in store');
    }

    if (classifyDecode(decoded) !== 'animated') {
      throw new Error('Re-decoded GIF has no animation frames');
    }

    // 2. Build GIF content (shared with import — includes frame count dialog).
    //    originalGifAssetId IS the fileHash used to mint the frame asset ids
    //    (same shape as import's storeRaw result) — pass it straight through.
    const content = await buildGifFrameContent(ctx, decoded, originalGifAssetId);
    if (!content) return false; // User cancelled

    // 3. Update frame in-place
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
