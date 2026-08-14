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
import type { DecodeOutput } from './_types';
import { isVectorFormat, promptVectorDpi } from './vector';

export type { DecodeOutput, ImportOptions } from './_types';

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
    file = await ctx.actions.withSignal(
      'sys.asset.downloading',
      () => ctx.pixels.utils.fetchFromUrl(source),
    );
  } else {
    file = source;
  }

  // 2. Detect format
  const format = ctx.files.detectFormat(file);

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
    decoded = await actions.withSignal(
      files.needsTranscoding(file) ? 'sys.asset.transcoding' : '',
      () => files.decode(file, decodeOptions),
    );
  } catch (err) {
    console.error(`[FrameCreate] File decode failed:`, err);
    actions.notifyHUD(`Failed to process file. The format may not be supported.`, 'error');
    return null;
  }

  return { decoded, file, sourceType, chosenDpi };
}

// ═══════════════════════════════════════════════════════════════════════════════
// addNewFrame — Unified "File → Frame" pipeline
// ═══════════════════════════════════════════════════════════════════════════════

import type { ImportOptions } from './_types';
import { importSingleImage } from './single';
import { importMultiSubImage } from './multi';

/**
 * addNewFrame — The single entry point for "File/URL → new Frame in store".
 *
 * Encapsulates: resolveAndDecode + multi-page routing + importSingleImage.
 * Both trunk and branchFromFile delegate to this function, differing only in opts.
 *
 * @param ctx - Editor context
 * @param source - File object or URL string
 * @param opts - Import options (switchFrame, parentId, seqNum, nameOverride, extra, dpi)
 * @returns Frame ID of the created frame, or empty string if user cancelled / decode failed.
 */
export async function addNewFrame(
  ctx: EditorContextValue,
  source: File | string,
  opts: ImportOptions,
): Promise<string> {
  // 1. Resolve + vector dialog + decode
  const result = await resolveAndDecode(ctx, source);
  if (!result) return '';

  const { decoded, file, sourceType, chosenDpi } = result;
  const finalOpts: ImportOptions = { ...opts, dpi: opts.dpi ?? chosenDpi };

  // 2. Route: multi-sub-image or single image
  if (decoded.subImages.length > 1) {
    const multiResult = await importMultiSubImage(ctx, decoded, file, sourceType, finalOpts);
    if (multiResult !== null) return multiResult;
    // null = fall through to single image (TIFF "First Page Only" mode)
  }

  const { frameId } = await importSingleImage(ctx, decoded, file, sourceType, finalOpts);
  return frameId;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Re-exports
// ═══════════════════════════════════════════════════════════════════════════════

export { importSingleImage } from './single';
export { importMultiSubImage } from './multi';
