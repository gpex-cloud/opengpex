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
    // Declared ingest termini (row 26 / 19d / 18 — HDR, animation, sub-8-bit)
    // are decisions, not failures: show the precise reason, keep the console
    // free of a failure stack.
    if (err instanceof UnsupportedIngestError) {
      actions.notifyHUD(err.message, 'error');
      return null;
    }
    console.error(`[FrameCreate] File decode failed:`, err);
    actions.notifyHUD(`Failed to process file. The format may not be supported.`, 'error');
    return null;
  }

  return { file, decoded, vectorDpi };
}

// ═══════════════════════════════════════════════════════════════════════════════
// createFrameFromFile — Unified "File → Frame" pipeline
// ═══════════════════════════════════════════════════════════════════════════════

import { UnsupportedIngestError } from '@opengpex/editor/core/files';
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
  //    widened, a vector source (SVG/EPS) now hits the raw-first branch and
  //    would otherwise re-rasterize at its intrinsic size (VectorHandler.decode uses
  //    `options?.forcedWidth || intrinsicSize.w`), silently changing the canvas
  //    resolution on revert. frame.canvas.{w,h}/frame.dpi hold the user's original
  //    choice, so forwarding them keeps revert dimensionally faithful.
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
  // frame.assetId is a unified id (`${fileHash}#${index}`) pointing at the
  // first frame's StoredAsset. `decodeAsset` accepts the whole id (the raw
  // lookup strips the `#index` suffix), but the per-frame precomputedHash
  // minting inside buildGifFrameContent needs the bare file hash — otherwise
  // ids like `${hash}#0#${i}` would be produced.
  const originalFileHash = originalGifAssetId.split('#')[0];
  if (!originalFileHash) return false;

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
    //    The bare file hash mints per-frame asset ids of the same shape as
    //    import (`${fileHash}#${index}`) — idempotent against the import-time
    //    records, so revert reuses rather than duplicates them.
    const content = await buildGifFrameContent(ctx, decoded, originalFileHash);
    if (!content) return false; // User cancelled

    // 3. Update frame in-place
    actions.updateFrame(frameId, {
      canvas: content.canvas,
      camera: content.camera,
      confinement: null,
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

// ═══════════════════════════════════════════════════════════════════════════════
// createFrameFromAsset — "Registered asset slice → new Frame"
// ═══════════════════════════════════════════════════════════════════════════════

import { asLocalShape } from '@opengpex/editor/core/types';
import { getDefaultCanvasClipBox } from '@opengpex/editor/core/helpers/selection';
import { newFrameId } from '../_naming';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { computeFragmentCenter } from '@opengpex/editor/core/geometry/operators/transform';
import type { ImageMetadata } from '@opengpex/editor/core/files/types';
import { presets } from '@opengpex/editor/core/helpers/preferences';

const VIEWPORT_FIT_PADDING = presets.get('VIEWPORT_FIT_PADDING');

/**
 * createFrameFromAsset — assemble and commit a new trunk frame whose base layer
 * REFERENCES an already-registered asset, cropped to `visibleShape`.
 *
 * The paste command's "New Frame" choice used to round-trip the clipboard's
 * 8-bit PNG through `createFrameFromFile`, re-ingesting it as a fresh 8-bit
 * sRGB asset — a silent bit-depth/gamut downgrade for internal copies whose
 * source asset is still resident. This importer instead builds the frame
 * natively (same assembly contract as `importSingleImage` /
 * `branchFromSelection`) with the base layer referencing the original
 * content-addressed asset: the fragment is expressed as a narrowed
 * `visibleShape` crop window (the same shape every fragment layer carries),
 * so the high-depth `dec:` truth and the true gamut tag ride along with the
 * asset id — zero re-encode, zero identity loss.
 *
 * The thumbnail is cropped from the asset's display blob (NOT resampled
 * whole): a fragment frame's canvas shows only the slice, so a full-asset
 * thumbnail would picture a different document than the frame opens.
 *
 * @returns the new frame id, or `undefined` when the asset is not resolvable —
 *          the caller is expected to fall back to the 8-bit blob path in that
 *          case (degradations stay honest, never silent: surface the HUD
 *          notice there).
 */
export async function createFrameFromAsset(
  ctx: EditorContextValue,
  params: {
    /** Content-addressed id of the ALREADY-REGISTERED source asset. */
    assetId: string;
    /** Fragment bounding (layer-local px) — becomes the new frame's canvas size. */
    bounding: { w: number; h: number };
    /** Fragment crop window in source-asset pixel coords (the layer's visibleShape). */
    visibleShape: { x: number; y: number; w: number; h: number };
    /** Frame display name, e.g. the "Pasted Image …" convention of the blob path. */
    displayName: string;
  },
): Promise<string | undefined> {
  const { assets, actions, state, geometry, pixels } = ctx;
  const { assetId, bounding, visibleShape, displayName } = params;

  const asset = assets.get(assetId);
  if (!asset) return undefined;

  const canvas = { w: bounding.w, h: bounding.h };

  // ── Thumbnail: crop the slice out of the shared asset and scale to the
  // same 512 long edge the file-import thumbnails use (`importSingleImage`)
  // — one Worker pass via resample's targetRect (crop + scale + WebP encode
  // together); no main-thread decode of the (possibly huge) shared asset.
  const thumbResult = await pixels.image.resample(asset.url, {
    maxSize: 512,
    targetRect: visibleShape,
    sourceGamut: asset.gamut,
    format: 'image/webp',
    quality: 0.9,
  });
  const { assetId: thumbAssetId, url: thumbAssetUrl } = await assets.register(thumbResult.displayBlob, {
    width: thumbResult.width,
    height: thumbResult.height,
    precomputedHash: thumbResult.precomputedHash,
  });

  // ── Frame metadata: the asset's own colour identity is the document truth
  // (bit depth / gamut), same anchor `branchFromSelection` uses. No EXIF is
  // inherited — a pasted slice is a new document, not the source file.
  const frameMetadata: ImageMetadata = {
    sourceFormat: 'unknown',
    sourceFileName: asset.sourceFileName,
    width: canvas.w,
    height: canvas.h,
    dpi: 72,
    dpiSource: 'default',
    colorSpace: asset.gamut,
    bitDepth: asset.bitDepth,
    hasAlpha: true,
    raw: {},
  };

  // ── Camera + canvas clip box: identical contract to single-file imports ──
  const { insets } = state.ui.theme.config;
  const camera = geometry.camera.getFitCamera(
    state.ui.viewportDim,
    canvas,
    { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right },
  );
  const canvasClipBox = getDefaultCanvasClipBox(canvas);

  // ── Base layer: reference the source asset, crop via visibleShape. The
  // slice sits centered on the new canvas (world origin = canvas center).
  // cx/cy is a POSE value, not the content position — the content world
  // center sits at cx + O(rect.origin), so the pose is re-derived so the
  // CONTENT lands centered even when the crop window sits far from the
  // source asset's top-left (a slice from a big image carries a large
  // rect origin; zeroing cx/cy would render the slice off-canvas).
  const pose = computeFragmentCenter(
    { x: 0, y: 0 },
    { x: visibleShape.x, y: visibleShape.y },
    0,
    { h: false, v: false },
  );
  const baseLayer = LayerFactory.getNewLayer({
    name: 'Background',
    src: asset.url,
    assetId,
    cx: pose.x,
    cy: pose.y,
    locked: true,
    bounding,
    visibleShape: asLocalShape(visibleShape),
  });
  const expandedLayers = LayerFactory.expandLayers([baseLayer]);

  const newFrame = LayerFactory.getNewFrame({
    id: newFrameId(false),
    name: displayName,
    source: displayName,
    layers: { byId: Object.fromEntries(expandedLayers.map(l => [l.id, l])), order: expandedLayers.map(l => l.id) },
    activeLayerId: baseLayer.id,
    canvas,
    camera,
    canvasClipBox,
    assetId,
    thumbnail: { src: thumbAssetUrl, assetId: thumbAssetId },
    dpi: 72,
    metadata: frameMetadata,
  });

  actions.addFrame(newFrame, true);
  return newFrame.id;
}
