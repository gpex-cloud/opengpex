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
 * Unified File Service types.
 *
 * This module defines ALL core type definitions for the file I/O layer:
 * - ImageMetadata: Two-layer metadata model (semantic + raw)
 * - Format capability queries
 * - ImageFormatHandler: Per-format handler contract
 * - FileService: Public facade interface
 *
 * Previously split across types.ts + metadata.ts; unified 2026-08-07.
 */

import type { GamutId, LocalRect } from '@opengpex/editor/core/types';
import type { ColorIdentity, ImageAssetPayload } from '@opengpex/editor/core/storage/asset/AssetStore';
import type { IngestDecision } from './strategy';

// ═══════════════════════════════════════════════════════════════════════════════
// Metadata Types (canonical definitions — re-exported by metadata.ts for compat)
// ═══════════════════════════════════════════════════════════════════════════════

/** Supported source format identifiers */
export type SourceFormat =
  | 'jpeg' | 'png' | 'bmp' | 'webp' | 'avif'
  | 'heic' | 'tiff' | 'raw' | 'svg' | 'eps' | 'gif' | 'unknown';

/** How the DPI value was determined */
export type DpiSource = 'exif' | 'png-phys' | 'bmp-header' | 'tiff-tag' | 'user' | 'default';

/** Semantic color space identifier */
export type ColorSpaceId =
  | 'srgb' | 'adobe-rgb' | 'display-p3' | 'prophoto-rgb'
  | 'cmyk' | 'grayscale' | 'unknown';

/**
 * ImageMetadata — unified image metadata.
 *
 * Two-layer model:
 * - Semantic layer: format-agnostic, UI can directly consume
 * - Raw layer: standard binary passthrough for lossless export round-trip
 *
 * Design principles:
 * - Raw layer stores only standard binary (base64 of raw bytes)
 * - One data, one representation (no duplication)
 * - All inline (no external AssetId references)
 * - Semantic layer is format-agnostic
 * - Raw layer supports round-trip (import → store → export injection)
 */
export interface ImageMetadata {

  // ═══ Basic Info ═══════════════════════════════════════════════════════════
  sourceFormat: SourceFormat;
  sourceFileName?: string;
  sourceFileSize?: number;
  width: number;
  height: number;

  // ═══ Physical Dimensions ═══════════════════════════════════════════════════
  dpi: number;
  dpiSource: DpiSource;

  // ═══ Color Info ═══════════════════════════════════════════════════════════
  colorSpace: ColorSpaceId;
  bitDepth: number;
  /** Per-channel data type. Default 'uint'. TIFF 32-bit float = 'float'. */
  sampleFormat?: 'uint' | 'float';
  hasAlpha: boolean;

  /**
   * Whether the source is a multi-frame container (animated GIF, multi-page
   * TIFF, multi-image HEIC). Read by `resolveIngestDecision` to route the
   * decode channel (e.g. GIF → `gifuct`) and to forbid verbatim passthrough.
   * Optional: a handler that does not populate it is treated as single-frame.
   */
  isMultiFrame?: boolean;

  // ═══ Camera ═══════════════════════════════════════════════════════════════
  camera?: {
    make?: string;
    model?: string;
    lensMake?: string;
    lensModel?: string;
    software?: string;
  };

  // ═══ Capture Parameters ═══════════════════════════════════════════════════
  capture?: {
    fNumber?: number;
    exposureTime?: number;
    iso?: number;
    focalLength?: number;
    whiteBalance?: string;
    flash?: boolean;
    orientation?: number;  // EXIF orientation 1-8
  };

  // ═══ Dates ═══════════════════════════════════════════════════════════════
  dates?: {
    created?: string;    // ISO 8601 (EXIF DateTimeOriginal)
    digitized?: string;  // ISO 8601 (EXIF DateTimeDigitized)
    modified?: string;   // ISO 8601 (EXIF DateTime / PNG tIME)
  };

  // ═══ GPS ═══════════════════════════════════════════════════════════════════
  gps?: {
    latitude?: number;
    longitude?: number;
    altitude?: number;
  };

  // ═══ Author / Copyright ════════════════════════════════════════════════════
  author?: {
    name?: string;
    copyright?: string;
    description?: string;
  };

  // ═══ Raw Layer: standard binary passthrough ════════════════════════════════
  raw: RawBinaryData;
}

/**
 * Raw binary data layer.
 *
 * All fields are base64-encoded standard format binary data.
 * No third-party library internal representations stored here.
 *
 * Data flow: import extract → base64 into state → export retrieve → inject target format
 */
export interface RawBinaryData {
  /**
   * ICC Profile (complete binary, base64).
   * Source: PNG iCCP / JPEG APP2 / WebP ICCP / HEIC colr box / TIFF tag 34675
   * Usage: inject into target format on export (per format rules)
   * Size: typically 0.5-50KB, max ~100KB
   */
  icc?: {
    data: string;       // base64 of raw ICC profile bytes
    name: string;       // Profile description (parsed from ICC desc tag)
  };

  /**
   * EXIF (TIFF IFD structure, base64).
   * Source: PNG eXIf chunk / JPEG APP1 (minus "Exif\0\0" prefix) / WebP EXIF chunk
   * Usage: inject into target format on export
   * Size: typically 5-50KB
   *
   * Note: This is standard TIFF IFD binary, not any library's JSON mapping.
   * Semantic field parsing (camera/capture/dates) is done once at import time,
   * results go into semantic layer. raw.exif is only used for export injection.
   */
  exif?: string;        // base64 of raw EXIF bytes (TIFF IFD structure)

  /**
   * XMP sidecar (UTF-8 XML string).
   * Source: JPEG APP1 XMP / PNG iTXt "XML:com.adobe.xmp" / TIFF tag 700
   * Size: typically <10KB
   */
  xmp?: string;         // UTF-8 XML string (not base64, already text)

  /** PNG gAMA gamma value (only meaningful for PNG, effective without ICC/sRGB) */
  gamma?: number;

  /**
   * Source transfer characteristic probed at ingest (HDR seam).
   *
   * ONLY populated by the RAW handler today, from the embedded ICC profile
   * name / DNG tags: an ST 2084 (PQ) marker → `'pq'`, HLG marker → `'hlg'`,
   * else `'sdr'` when a colour signal was found, `undefined` when nothing was
   * probed. WRITE-ONLY this phase — no consumer reads it yet; it is the forward
   * seam the future HDR pipeline reads to branch PQ/HLG rendering. Distinct
   * from `ColorIdentity.trc` (`srgb-trc | linear`), which is the STORAGE/render
   * TRC of the decoded pixels, not the source's original transfer function.
   */
  transfer?: 'pq' | 'hlg' | 'sdr';

  /**
   * DNG `ProfileToneCurve` (tag 50940) control points, `[input, output]` pairs
   * in [0, 1] and increasing in `input` — the camera vendor's own rendering
   * intent curve.
   *
   * ONLY populated by the RAW handler, and only when the container actually
   * carries the tag (Apple ProRAW, Pixel/Expert RAW, Adobe DNG Converter output;
   * absent from most native DSLR RAW). Currently write-only — nothing samples
   * it. It serves as a rendering intent seam: an enhanced rendering intent samples this
   * LUT when present and degrades to the generic filmic baseline when not.
   *
   * Structural type (not `DngToneCurvePoint`) so this base module stays free of
   * handler-layer imports.
   */
  dngToneCurve?: readonly (readonly [number, number])[];

  /**
   * DNG camera-profile colour tables: `ProfileHueSatMap`
   * (tags 50937/50938/50939 — a hue/sat/value warp grid) and `ProfileLookTable`
   * (tags 50981/50982 — the creative-Look grid; Apple ProRAW's vivid look lives
   * largely here). Each grid is `dims = [hDiv, sDiv, vDiv]` addressing
   * `hDiv*sDiv*vDiv*3` floats of `(hueShift°, satScale, valScale)` triples.
   *
   * ONLY populated by the RAW handler, and only when the container carries the
   * tags (absent from most native DSLR RAW). Reserved for forward display-engine
   * seams. Structural type
   * (not `DngHueSatMap` / `DngLookTable`) so this base module stays free of
   * handler-layer imports.
   */
  dngProfile?: {
    hueSatMap?: {
      dims: readonly [number, number, number];
      data1: readonly number[];
      data2?: readonly number[];
    };
    lookTable?: {
      dims: readonly [number, number, number];
      data: readonly number[];
    };
  };

  /**
   * Raw PNG tEXt/iTXt key-value entries.
   * Preserves non-standard text chunks (e.g. ComfyUI "prompt" workflow JSON,
   * SD WebUI "parameters") for round-trip and AI provenance detection.
   * Only populated for PNG sources.
   */
  pngText?: Record<string, string>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Format Capability Queries
// ═══════════════════════════════════════════════════════════════════════════════

/** Formats that support EXIF metadata embedding on export. */
const EXIF_CAPABLE_FORMATS = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/avif']);

/**
 * Whether a given format supports EXIF metadata embedding.
 * Used by UI to conditionally show "Keep EXIF" toggle.
 */
export function supportsExifEmbed(format: string): boolean {
  return EXIF_CAPABLE_FORMATS.has(format);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Service Options
// ═══════════════════════════════════════════════════════════════════════════════

export interface DecodeOptions {
  /**
   * Caller-supplied decode OVERRIDES — genuine external inputs, distinct from the
   * entry's own ingest context. Today the sole source is the vector-import DPI
   * dialog (`promptVectorDpi`), a UI concern that deliberately lives OUTSIDE the
   * FileService. `metadata` + `decision` are NOT here: they are the entry's
   * pre-resolved context and reach a handler as explicit `decode(...)` arguments,
   * never smuggled through this bag.
   */

  /** Forced rasterization DPI for vector import (from the UI DPI dialog). */
  forcedDpi?: number;
  /** Forced rasterization width in px for vector import. */
  forcedWidth?: number;
  /** Forced rasterization height in px for vector import. */
  forcedHeight?: number;
}

export interface EncodeOptions {
  /** Compression quality (0-1) */
  quality?: number;
  /** Source metadata to inject into output */
  metadata?: ImageMetadata;
  /** Export-specific metadata configuration */
  exportConfig?: ExportMetadataConfig;
}

export interface ExportMetadataConfig {
  /** Output DPI (overrides metadata.dpi) */
  dpi?: number;
  /** Preserve original EXIF data in output */
  preserveExif?: boolean;
  /** Embed ICC Profile in output */
  embedIcc?: boolean;
  /** Write software identification tag */
  writeSoftwareTag?: boolean;
  /** Override author/copyright for this export */
  author?: { name?: string; copyright?: string };

  /**
   * The gamut the pixels handed to the encoder ARE in = the egest decision's
   * `targetGamut` (`core/files/strategy/egest.ts`) — already clamped to what this
   * container can carry, so the name and the meaning are identical end to end.
   *
   * The terminal `unpremultiplyEncodeGamut` already converted into this gamut and
   * applied its TRC, so the encoder does ZERO colour math — it reads this only to
   * pick the canvas `colorSpace` tag (`toCanvasColorSpace`) and the embedded stock
   * ICC profile (`getStockIccProfile`).
   *
   * It replaced a second field, `frameColorSpace` (the document's working space),
   * which said the same thing less accurately: because the working buffer is always
   * Linear Display-P3, feeding that to the old `resolveExportPixelConversion`
   * reported a spurious `'p3-to-srgb'` for a plain sRGB export and converted twice.
   *
   * When undefined, encoders fall back to plain `'srgb'` tagging.
   */
  targetGamut?: GamutId;

  // ─── Format-specific options (passed through to handlers) ───
  /** TIFF compression method */
  tiffCompression?: string;
  /** PNG compression level (0-9) */
  pngCompression?: number;
  /**
   * JPEG quality (1-100) for the JPEG codec INSIDE a TIFF — only read when
   * `tiffCompression === 'jpeg'`. Unrelated to `EncodeOptions.quality` (0-1),
   * which is the JPEG/WebP/AVIF container quality.
   */
  tiffJpegQuality?: number;
  /** TIFF predictor */
  tiffPredictor?: string;
  /** BigTIFF format */
  tiffBigtiff?: boolean;
  /** Tile layout */
  tiffTile?: boolean;
  /** Tile width */
  tiffTileWidth?: number;
  /** Tile height */
  tiffTileHeight?: number;
}

/**
 * A single fully-decoded image — the complete, self-contained representation
 * of ONE image inside a decoded file.
 *
 * Unified representation for:
 * - Single-page images (JPEG/PNG/WebP/BMP/HEIC/RAW/TIFF single) → the sole page
 * - Multi-page TIFF pages
 * - Animated GIF/APNG frames
 *
 * Extends the storage layer's producer-agnostic `ImageAssetPayload` (so a
 * page IS a valid `AssetService.storeBundle` payload with zero adaptation),
 * adding only the two file-decode-specific facts an in-composite bake product
 * (`CompositedImage`) has no use for: page ordering and animation delay.
 * Self-contained: it carries its own `colorIdentity` and (optionally) its own
 * high-depth naked pixels, so a consumer can ingest one page without reading
 * anything back off the parent `DecodeResult`. Formerly `SubImage`, when colour
 * identity + high-depth pixels lived once at the file level and could not be
 * expressed per-page (the multi-page 16-bit TIFF gap).
 *
 * Invariant on `highDepthSource`: its `width`/`height` are IDENTICAL to this
 * image's display `width`/`height`. The decode handlers upright the naked
 * buffer with the same EXIF Orientation as the display proxy (PNG/WebP
 * `rotateNakedRgba`), so the two never disagree — including for orientation 5-8
 * where both are the post-EXIF (swapped) dims. This makes the light record's
 * geometry a valid source for reconstructing the high-depth buffer.
 */
export interface DecodedImage extends ImageAssetPayload {
  /** Zero-based index within the source file */
  readonly index: number;

  /**
   * Frame delay in milliseconds.
   * Present ONLY for animated formats (GIF, APNG, WebP animation).
   * Undefined for static multi-page formats (TIFF pages, PDF pages).
   */
  readonly delay?: number;

  /**
   * Precomputed visible-content bounding box (non-transparent region).
   * Populated by FileService.decode during ingest.
   * Guaranteed to match { x: 0, y: 0, w: width, h: height } when `hasAlpha` is false.
   */
  readonly contentBounds?: LocalRect;
}

/** Decode result returned by the FileService — a thin file-level container over `pages`. */
export interface DecodeResult {
  /** Extracted metadata (format-agnostic semantic layer, file-level) */
  metadata: ImageMetadata;

  /**
   * Decoded pages: always present, length ≥ 1. Each element is a complete,
   * self-contained `DecodedImage` (own `colorIdentity`, own optional
   * `highDepthSource`), so per-page colour identity and high-depth pixels are
   * now expressible — the multi-page 16-bit TIFF gap that a single file-level
   * `colorIdentity`/`highDepthSource` could not represent.
   *
   * - Single-page file → length = 1
   * - Multi-page TIFF → length = N pages
   * - Animated GIF/APNG → length = N frames
   *
   * Consumers iterate this array uniformly. (Formerly `subImages`.)
   */
  pages: DecodedImage[];

  /**
   * Original source blob for high-fidelity operations.
   *
   * Present when:
   * - Source bit depth > 8 (16-bit TIFF/PNG/RAW) → enables lossless 16-bit export
   * - Source is multi-page → worker extracts pages by index on demand
   *
   * NOT present for standard 8-bit single-page files (JPEG/PNG/WebP) since
   * the displayBlob IS the final representation.
   *
   * Design: ONE shared source blob (not N per-page copies) — memory efficient.
   */
  sourceBlob?: Blob;
}

/**
 * A page as produced by a format handler: a `DecodedImage` whose
 * `colorIdentity` is OPTIONAL (it stays REQUIRED on `DecodedImage` itself).
 *
 * The FileService entry (Stage 4) injects each page's `colorIdentity` from the
 * authoritative `IngestDecision` (Path B — the decision is the single colour
 * authority), so no handler synthesises colour identity itself. `highDepthSource`
 * (when present) is therefore the BARE `{ data, width, height }` payload; its
 * container / trc / gamut are read from the injected sibling `colorIdentity`.
 *
 * The optional `colorIdentity` is the ONE deliberate crack in that rule. It
 * exists ONLY for formats whose pages can carry genuinely different colour per
 * page within the same file (currently: only multi-page TIFF, where each IFD may
 * declare its own PhotometricInterpretation / BitsPerSample / ICC). A handler
 * that leaves it unset — every single-page handler, GIF/APNG frames, and TIFF's
 * own single-page branch — gets the file-level `decision.colorIdentity` from the
 * entry's Stage 4 fallback, so there is zero behaviour change for any format
 * that does not need this. See `files/index.ts` Stage 4.
 */
export type DecodedPayload = Omit<DecodedImage, 'colorIdentity'> & {
  colorIdentity?: ColorIdentity;
};

/** Raw pixel data source for direct export (supports 8/16-bit without 8-bit Canvas degradation) */
export interface RawPixelSource {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint16Array | Uint8ClampedArray;
  readonly bitDepth: 8 | 16 | 32;
  readonly colorSpace?: string;
}

export type EncodeSource = HTMLCanvasElement | OffscreenCanvas | ImageBitmap | RawPixelSource;

export function isRawPixelSource(source: unknown): source is RawPixelSource {
  return (
    typeof source === 'object' &&
    source !== null &&
    'width' in source &&
    'height' in source &&
    'data' in source &&
    'bitDepth' in source
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Handler & Service Interfaces
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Per-format image handler.
 *
 * Each handler encapsulates all format-specific logic:
 * - Decoding (transcoding non-standard formats to browser-safe versions)
 * - Encoding (compressing pixels to target format with metadata injection)
 * - Metadata extraction (reading headers without full decode)
 *
 * Dependencies (AssetService, WorkerProxy) are injected at construction time,
 * keeping method signatures clean and preventing circular references.
 */
export interface ImageFormatHandler {
  /** Format identifier (e.g., 'jpeg', 'png', 'heic') */
  readonly format: string;
  /** MIME types handled by this handler */
  readonly mimeTypes: string[];
  /** File extensions handled (without dot, lowercase) */
  readonly extensions: string[];
  /**
   * Whether this format requires heavy transcoding (WASM/Worker) during decode.
   * When true, the UI should show a "Converting…" indicator during file load.
   * Defaults to false if not specified.
   */
  readonly needsTranscoding?: boolean;

  /**
   * Decode: transcode to browser-safe format + produce display pixels.
   * For natively supported formats (JPEG/PNG), returns the original file.
   * For non-native formats (HEIC/RAW/SVG/EPS), transcodes to PNG/JPEG.
   *
   * `metadata` and `decision` are the entry-resolved ingest context, passed as
   * REQUIRED arguments — `createFileService().decode` is their single source, so
   * a handler consumes them directly with no re-sniff or runtime re-validation.
   * `options` carries only caller-supplied overrides (vector DPI).
   *
   * A handler is a PURE pixel producer: it never mints `colorIdentity` nor
   * decides `sourceBlob` retention — the FileService entry owns both, injecting
   * per-page `colorIdentity` and the file-level `sourceBlob` from the single
   * `resolveIngestDecision` call. Hence the naked `DecodedPayload[]` (a
   * `DecodedImage[]` minus `colorIdentity`); the entry maps it into the public
   * `DecodeResult`.
   */
  decode(
    file: File,
    metadata: ImageMetadata,
    decision: IngestDecision,
    options?: DecodeOptions,
  ): Promise<DecodedPayload[]>;

  /**
   * Encode: compress Canvas/Bitmap to this format with metadata/DPI injection.
   */
  encode(
    source: EncodeSource,
    options: EncodeOptions,
  ): Promise<Blob>;

  /**
   * Fast metadata-only extraction (reads file header, no pixel decode).
   */
  extractMetadata(file: File): Promise<ImageMetadata>;
}

export interface DecodeBlobInput {
  blob: Blob;
  width: number;
  height: number;
  metadata: ImageMetadata;
}

/**
 * Unified FileService facade.
 *
 * Entry point for all file format I/O operations.
 * Routes to the appropriate ImageFormatHandler based on file type/extension.
 *
 * Dependency: AssetService + WorkerProxy (injected via createFileService factory).
 * Does NOT depend on PixelService (peer relationship, no circular refs).
 */
export interface FileService {
  /** Get handler for a given file (by MIME type + extension detection) */
  getHandler(file: File): ImageFormatHandler;
  /** Get handler by MIME type string */
  getHandlerByMimeType(mimeType: string): ImageFormatHandler;

  /**
   * Unified decode: format detection + transcoding + metadata extraction.
   * Single call handles format detection, transcoding, and metadata extraction.
   */
  decode(file: File, options?: DecodeOptions): Promise<DecodeResult>;

  /**
   * Compose a single-page DecodeResult from an already-encoded blob (branch-from-
   * selection, future paste/generate entries). Structurally mirrors `decode`'s
   * Stage 2/4: derives colorIdentity from metadata via resolveIngestDecision.
   */
  decodeBlob(input: DecodeBlobInput): DecodeResult;

  /**
   * Unified encode: pixel compression + metadata/DPI injection.
   * Single call replaces the old convertToBlob + injectToBlob + injectPngDpi pattern.
   */
  encode(
    source: EncodeSource,
    mimeType: string,
    options: EncodeOptions,
  ): Promise<Blob>;

  /**
   * Fast metadata extraction (no transcoding).
   */
  extractMetadata(file: File): Promise<ImageMetadata>;

  /**
   * Get export filename with correct extension for the given format.
   */
  getExportFilename(baseName: string, w: number, h: number, mimeType: string): string;

  /**
   * Whether a file requires heavy transcoding (WASM/Worker decode).
   * Used by the command layer to decide whether to show a "Converting…" indicator.
   * Delegates to the matched handler's `needsTranscoding` flag.
   */
  needsTranscoding(file: File): boolean;

  /**
   * Cold recovery: assetId → original encodable bytes → DecodeResult. Two-tier
   * fallback, cheapest/most-faithful first:
   *   1. `assets.getRaw(id)` — the `storeRaw`-persisted original (16-bit
   *      TIFF/PNG/RAW, or an animated GIF's original bytes);
   *   2. `assets.hydrate` + `get(id).blob` — an 8-bit asset, whose displayBlob
   *      IS the original.
   * Both empty → null (the caller owns the error messaging).
   * Pairs with `recover(assetId)`: `recover` fetches naked high-depth pixels,
   * `decodeAsset` fetches decodable bytes.
   */
  decodeAsset(assetId: string, fileName?: string, options?: DecodeOptions): Promise<DecodeResult | null>;

  /**
   * Recover the high-bit-depth naked pixels for an asset on a COLD RELOAD/revert,
   * when the in-memory HighDepthTextureCache is empty. Three-tier, cheapest first:
   *   1. persisted self-describing high-depth buffer (`assets.get` light record's
   *      `dataFormat` + `assets.getDec`) — bake products + RAW imports, a direct
   *      warm with no decode;
   *   2. else the encoded source file (`assets.getRaw`) re-decoded via the
   *      files-layer shared vips worker (TIFF/PNG).
   * Returns null when the source is ≤8-bit (negative-cache upstream) or absent.
   *
   * This is the files-layer home of what was the engine `decodeHighDepth` path:
   * "recover a file's high-depth pixels" is file decoding, so it belongs here.
   *
   * `dataFormat` reports the container `data` actually is and MUST be passed through
   * from the source, not downgraded: a 32-bit float source recovers as a
   * `Float32Array` / `rgba32float`. Re-labelling those bytes `rgba16float` halves
   * the `bytesPerRow` the GPU upload computes and shreds the image.
   */
  recover(assetId: string): Promise<{
    data: Uint16Array | Float32Array;
    width: number;
    height: number;
    dataFormat: 'rgba16float' | 'rgba32float';
    trc: 'srgb-trc' | 'linear';
    gamut?: GamutId;
  } | null>;
}
