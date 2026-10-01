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
 * Unified File Service — factory and public exports.
 *
 * Creates a FileService instance with all format handlers registered.
 * Dependencies: AssetService (for registering ICC/EXIF blobs).
 */

import type { AssetService } from '@opengpex/editor/core/types';
import type {
  FileService,
  ImageFormatHandler,
  ImageMetadata,
  DecodeOptions,
  DecodeResult,
  DecodedPayload,
  EncodeOptions,
  EncodeSource,
  RawPixelSource,
  DecodeBlobInput,
} from './types';
import { isRawPixelSource } from './types';
export { isRawPixelSource };
export type { EncodeSource, RawPixelSource };
import { JpegHandler } from './handlers/jpeg';
import { PngHandler } from './handlers/png';
import { BmpHandler } from './handlers/bmp';
import { HeicHandler } from './handlers/heic';
import { TiffHandler } from './handlers/tiff';
import { RawHandler } from './handlers/raw';
import { WebpHandler } from './handlers/webp';
import { AvifHandler } from './handlers/avif';
import { VectorHandler, getVectorIntrinsicSize, detectVectorFormat, needsRasterSize, computeRasterSize, MAX_RASTER_DIMENSION } from './handlers/vector';
import { GifHandler } from './handlers/gif';
import { mimeToExt } from './shared/mime';
// strategy.ts is NOT part of the './color' barrel — the entry imports the single
// ingest-decision authority explicitly.
import { resolveIngestDecision } from './strategy';
import type { IngestDecision } from './strategy';

// Re-export vector utilities (used by frame/create command)
export { getVectorIntrinsicSize, detectVectorFormat, needsRasterSize, computeRasterSize, MAX_RASTER_DIMENSION };

// Re-export metadata display + file acquisition + page semantics helpers
export { hasDisplayableMetadata, isComfyUiWorkflow, toFile, fromUrl, classifyDecode } from './utils';
export type { DecodeKind } from './utils';

// Re-export all public types
export type {
  FileService,
  ImageFormatHandler,
  DecodeOptions,
  DecodeResult,
  EncodeOptions,
  ExportMetadataConfig,
  SourceFormat,
  DpiSource,
  ColorSpaceId,
  DecodeBlobInput,
} from './types';

// Re-export V2 metadata types
export type { ImageMetadata, RawBinaryData } from './types';

// Re-export unified ingest decision strategy
export { resolveIngestDecision, isWideGamut } from './strategy';
export type { IngestDecision, DecodeChannel } from './strategy';

// Re-export unified egest (export) decision strategy — the mirror of the above.
export { resolveEgestDecision, resolveEmbedIcc, FORMAT_EGEST_CAPABILITIES } from './strategy';
export type { EgestDecision, EgestRequest, EgestChannel, FormatEgestCapability } from './strategy';


// ═══════════════════════════════════════════════════════════════════════════════
// Fallback Handler (for unknown/unsupported formats)
// ═══════════════════════════════════════════════════════════════════════════════

class FallbackHandler implements ImageFormatHandler {
  readonly format = 'unknown';
  readonly mimeTypes: string[] = [];
  readonly extensions: string[] = [];

  async decode(
    file: File,
    _metadata: ImageMetadata,
    _decision: IngestDecision,
    _options?: DecodeOptions,
  ): Promise<DecodedPayload[]> {
    // Return file as-is — let the browser try to handle it. The real canvas size
    // comes from a browser probe and rides on the page (per-page dims are truth);
    // file-level `metadata` is the entry's Stage 1 object, injected around us.
    const img = await createImageBitmap(file);
    const dimensions = { w: img.width, h: img.height };
    img.close();
    return [{ displayBlob: file, width: dimensions.w, height: dimensions.h, index: 0 }];
  }

  async encode(
    source: EncodeSource,
    _options: EncodeOptions,
  ): Promise<Blob> {
    // Fallback: encode as PNG
    const canvas = source instanceof ImageBitmap
      ? bitmapToCanvas(source)
      : (source as OffscreenCanvas);
    return (canvas as OffscreenCanvas).convertToBlob({ type: 'image/png' });
  }

  async extractMetadata(file: File): Promise<ImageMetadata> {
    return {
      sourceFormat: 'unknown',
      sourceFileName: file.name,
      sourceFileSize: file.size,
      width: 0,
      height: 0,
      dpi: 72,
      dpiSource: 'default',
      colorSpace: 'srgb',
      bitDepth: 8,
      hasAlpha: false,
      raw: {},
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utility: ImageBitmap → OffscreenCanvas
// ═══════════════════════════════════════════════════════════════════════════════

/** Convert ImageBitmap to OffscreenCanvas for encoding APIs */
export function bitmapToCanvas(bitmap: ImageBitmap, colorSpace?: PredefinedColorSpace): OffscreenCanvas {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', colorSpace ? { colorSpace } : undefined)!;
  ctx.drawImage(bitmap, 0, 0);
  return canvas;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Factory: createFileService
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a unified FileService instance.
 *
 * @param assets - AssetService for registering ICC/EXIF blobs
 */
export function createFileService(
  assets: AssetService,
): FileService {
  // Instantiate all format handlers
  const handlers: ImageFormatHandler[] = [
    new JpegHandler(),
    new PngHandler(),
    new WebpHandler(),
    new AvifHandler(),
    new BmpHandler(),
    new GifHandler(),
    new HeicHandler(assets),
    new TiffHandler(assets),
    new RawHandler(assets),
    new VectorHandler(),
  ];

  const fallback = new FallbackHandler();

  // Build lookup maps for fast routing
  const mimeMap = new Map<string, ImageFormatHandler>();
  const extMap = new Map<string, ImageFormatHandler>();

  for (const handler of handlers) {
    for (const mime of handler.mimeTypes) {
      mimeMap.set(mime, handler);
    }
    for (const ext of handler.extensions) {
      extMap.set(ext, handler);
    }
  }

  /** Route file → handler */
  function getHandler(file: File): ImageFormatHandler {
    // Try MIME type first
    const type = file.type.toLowerCase();
    if (type && mimeMap.has(type)) return mimeMap.get(type)!;

    // Fallback to extension
    const ext = file.name.toLowerCase().split('.').pop() || '';
    if (ext && extMap.has(ext)) return extMap.get(ext)!;

    return fallback;
  }

  /** Route MIME type string → handler */
  function getHandlerByMimeType(mimeType: string): ImageFormatHandler {
    if (!mimeType || typeof mimeType !== 'string') return fallback;
    return mimeMap.get(mimeType.toLowerCase()) || fallback;
  }

  // ─── Build the FileService facade ──────────────────────────────────────────

  const service: FileService = {
    getHandler,
    getHandlerByMimeType,

    /**
     * Unified decode — the two-stage ingest pipeline (single decision point).
     *
     * Stage 1: sniff objective metadata (header-only extract).
     * Stage 2: resolve the authoritative IngestDecision — the ONLY call site of
     *          `resolveIngestDecision` in the whole codebase.
     * Stage 3: hand the pre-resolved decision + metadata to the format handler,
     *          which becomes a pure pixel producer.
     * Stage 4: the entry uniformly mounts `colorIdentity` and `sourceBlob`, so no
     *          handler can under- or over-report them.
     */
    async decode(file: File, options?: DecodeOptions): Promise<DecodeResult> {
      const handler = getHandler(file);

      // Stage 1: sniff objective metadata (header-only extract).
      const metadata = await handler.extractMetadata(file);

      // Stage 2: the single authoritative ingest decision. AVIF >8-bit degrades
      // to 8-bit here per strategy.ts (no throw), and the working gamut is the
      // engine constant WORKING_GAMUT — never derived from the image.
      const decision = resolveIngestDecision(metadata);

      // Stage 3: pure pixel extraction. `metadata` + `decision` are the entry's
      // own resolved context, handed to the handler as explicit arguments (not an
      // options bag it must re-validate); `options` carries only caller overrides.
      // The handler emits naked pages (no colorIdentity); any metadata enrichment
      // (e.g. TIFF ICC backfill) happens in-place on the shared `metadata` object.
      const pages = await handler.decode(file, metadata, decision, options);

      // Stage 4: entry-owned result wrapping. Path B — the entry injects the
      // authoritative `colorIdentity` into every page (the decision is the single
      // colour authority; handlers never mint it), and owns `sourceBlob` retention.
      // The ONE exception: a handler whose pages can genuinely carry different
      // colour per page (only multi-page TIFF today — each IFD may declare its own
      // PhotometricInterpretation / BitsPerSample / ICC) may set `colorIdentity`
      // itself, and that per-page value wins. Every other handler leaves it unset
      // and takes the file-level decision unchanged.
      const result: DecodeResult = {
        metadata,
        pages: pages.map((page) => ({
          ...page,
          colorIdentity: page.colorIdentity ?? decision.colorIdentity,
          sourceFileName: metadata.sourceFileName ?? file.name,
        })),
        sourceBlob: decision.retainSourceBlob ? file : undefined,
      };



      return result;
    },

    decodeBlob(input: DecodeBlobInput): DecodeResult {
      return decodeBlob(input);
    },

    async encode(
      source: EncodeSource,
      mimeType: string,
      options: EncodeOptions,
    ): Promise<Blob> {
      const handler = getHandlerByMimeType(mimeType);
      return handler.encode(source, options);
    },

    async extractMetadata(file: File) {
      const handler = getHandler(file);
      return handler.extractMetadata(file);
    },

    getExportFilename(baseName: string, w: number, h: number, mimeType: string): string {
      const ext = mimeToExt[mimeType] || mimeType.split('/')[1] || 'png';
      return `${baseName}-${w}x${h}.${ext}`;
    },

    needsTranscoding(file: File): boolean {
      const handler = getHandler(file);
      return handler.needsTranscoding === true;
    },

    /**
     * Cold recovery: assetId → original encodable bytes → DecodeResult.
     * Two-tier fallback, cheapest/most-faithful first:
     *   1. assets.getRaw(id) — the `storeRaw`-persisted original (16-bit
     *      TIFF/PNG/RAW, or an animated GIF's original bytes);
     *   2. assets.hydrate + get(id).blob — an 8-bit asset, whose displayBlob
     *      IS the original.
     * Both empty → null (the caller owns the error messaging).
     */
    async decodeAsset(assetId: string, fileName?: string, options?: DecodeOptions): Promise<DecodeResult | null> {
      let blob: Blob | null = await assets.getRaw(assetId);
      if (!blob) {
        await assets.hydrate(new Set([assetId]));
        blob = assets.get(assetId)?.blob ?? null;
      }
      if (!blob) return null;

      const file = new File([blob], fileName || 'image', { type: blob.type });
      return service.decode(file, options);
    },

    async recover(assetId: string) {
      // Ensure the asset's light record is hydrated in memory (mirrors decodeAsset).
      let lightRecord = assets.get(assetId);
      if (!lightRecord && assets.hydrate) {
        await assets.hydrate(new Set([assetId]));
        lightRecord = assets.get(assetId);
      }

      // 1. Persisted self-describing high-depth buffer (bake products + RAW
      //    imports): a direct warm, no decode. Fastest, and the ONLY viable path
      //    for RAW (its `raw:` blob is the original camera file vips cannot read).
      //    Mirrors the layer-service cold-reload pattern (core/layer/services/resample.ts):
      //    the light record's `dataFormat` is the persisted "a dec: truth exists"
      //    predicate; geometry/colour identity are reassembled from THAT record,
      //    not from the bare `getDec` buffer (which carries no metadata).
      if (lightRecord?.dataFormat) {
        const decData = await assets.getDec(assetId);
        if (decData) {
          return {
            data: decData,
            width: lightRecord.width,
            height: lightRecord.height,
            // Pass the persisted container through verbatim. This used to
            // rewrite 'rgba32float' → 'rgba16float', which described f32 bytes as
            // 8 bytes/texel and mis-strided every row of a recovered 32-bit source.
            dataFormat: lightRecord.dataFormat,
            trc: lightRecord.trc,
            gamut: lightRecord.gamut,
            renderIntent: lightRecord.renderIntent,
          };
        }
      }
      // 2. Encoded source file (TIFF/PNG/RAW/HEIC) → re-decode via the full format routing pipeline.
      const rawBlob = await assets.getRaw(assetId);
      if (!rawBlob) return null;

      const fileName = lightRecord?.sourceFileName ?? 'recovered';
      let result: DecodeResult | null = null;
      try {
        result = await service.decodeAsset(assetId, fileName);
      } catch (err) {
        console.warn('[FileService.recover] decodeAsset failed for', assetId, err);
      }

      if (result && result.pages.length > 0) {
        const pageIndexStr = assetId.includes('#') ? assetId.split('#')[1] : '0';
        const pageIndex = parseInt(pageIndexStr, 10) || 0;
        const page = (pageIndex >= 0 && pageIndex < result.pages.length)
          ? result.pages[pageIndex]
          : result.pages[0];

        if (page.colorIdentity.dataFormat && page.highDepthSource) {
          return {
            data: page.highDepthSource.data,
            width: page.highDepthSource.width,
            height: page.highDepthSource.height,
            dataFormat: page.colorIdentity.dataFormat,
            trc: page.colorIdentity.trc,
            gamut: page.colorIdentity.gamut ?? lightRecord?.gamut ?? 'srgb',
            renderIntent: page.colorIdentity.renderIntent ?? lightRecord?.renderIntent,
          };
        }
      }

      // decodeAsset failed, or the page it produced carries no highDepthSource.
      // No further fallback: for the channels this matters most (`libraw`,
      // `heic-to`) the raw source bytes are exactly what the browser's native
      // decode already can't read, so re-attempting a bare readback here would
      // just fail the same way. The caller (HighDepthTextureCache) negative-
      // caches this and degrades to the 8-bit display path.
      return null;
    },
  };

  return service;
}

// ═══════════════════════════════════════════════════════════════════════════════
// decodeBlob — Compose a DecodeResult from an already-encoded blob
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Synthesize a single-page `DecodeResult` from an existing blob (branch-from-
 * selection, future paste/generate entries). Structurally mirrors `decode`'s
 * Stage 2/4: `colorIdentity` is never supplied by the caller, it is derived by
 * feeding `metadata` into `resolveIngestDecision` — a synthetic ingest is
 * treated as "decoding the same PNG again", so the command layer never mints
 * colour identity itself (Path B, the single authority stays in this module).
 */
export function decodeBlob(input: DecodeBlobInput): DecodeResult {
  const { blob, width, height, metadata } = input;
  const decision = resolveIngestDecision(metadata);

  return {
    metadata,
    pages: [{
      displayBlob: blob,
      width,
      height,
      index: 0,
      colorIdentity: decision.colorIdentity,
      sourceFileName: metadata.sourceFileName,
    }],
    sourceBlob: decision.retainSourceBlob ? blob : undefined,
  };
}

// Re-export MIME utilities (stateless helpers used without FileService access)
export { mimeToFormat, formatToMime, detectFormat } from './shared/mime';

// Re-export DPI utilities consumed by external modules (plugins / UI components)
export { DPI_PRESETS, formatPrintSize } from './shared/dpi';
export { supportsExifEmbed } from './types';

