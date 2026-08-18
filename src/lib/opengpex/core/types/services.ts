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

import type { CompositeRequest, CompositeResult, ResampleResult } from '../engine/types';

import {
  Frame,
  Layer,
  AdjustmentState,
  CurvesState,
  LevelsState,
  ChannelMixState,
  ColorBalanceState,
  VectorMask,
  BitmapMask,
  LayerBlendMode,
} from './models';
import {
  LocalRect, Dimensions, Shape, LocalShape, LocalPolygon, TileMetadata
} from './primitives';
import { EditorData } from './state';
import type { ImageMetadata } from '../files/metadata';

/**
 * RenderToBlobOptions: Unified options for composite-to-blob export operations.
 *
 * This options bag expresses "what does the user want" (format / bit depth / metadata / quality / exportConfig)
 * so that the PixelService facade can decide "which backend/encoder to route to" internally.
 */
export interface RenderToBlobOptions {
  /** MIME type, or the special string 'raw' to receive an ImageBitmap (no encoding). */
  format?: string;
  /** JPEG/WebP/AVIF quality 0..1. Default 0.92. */
  quality?: number;
  /** Target bit depth. 16 requests the vips-native lane when eligible; 8 forces the standard lane. */
  exportBitDepth?: 8 | 16;
  /** Optional metadata (EXIF passthrough, ICC profile) to inject during encoding. */
  metadata?: ImageMetadata;
  /** Encoder-side options passed through to files.encode / vips encode. */
  exportConfig?: {
    dpi?: number;
    preserveExif?: boolean;
    writeSoftwareTag?: boolean;
    /** Embed ICC Profile in output and convert pixels to original color space. */
    embedIcc?: boolean;
    /** Frame's working color space at export time (for color pipeline export strategy). */
    frameColorSpace?: 'srgb' | 'display-p3' | 'adobe-rgb' | 'prophoto-rgb';
    /** TIFF compression algorithm (e.g. 'lzw' / 'none' / 'deflate'). */
    tiffCompression?: string;
    /** PNG compression level 0..9. */
    pngCompression?: number;
    /** JPEG quality 1..100 (overrides `quality`). */
    jpegQuality?: number;
    /** TIFF predictor. */
    tiffPredictor?: string;
    /** BigTIFF flag. */
    tiffBigtiff?: boolean;
    /** Tiled TIFF flag. */
    tiffTile?: boolean;
    tiffTileWidth?: number;
    tiffTileHeight?: number;
    /** Resize final output to this dim (post-composite/post-crop). */
    resize?: { w: number; h: number };
  };
  /** Legacy: kept for backwards compatibility with internal callers (AsyncFilterCache etc.). */
  targetDpr?: number;
  /**
   * When set, only layers whose id is in this array are rendered; all others are excluded.
   * Ignores the `visible` flag of the specified layers — they are always rendered.
   *
   * If omitted, all visible layers are rendered (default behavior, unchanged).
   */
  layerIds?: string[];
}



export interface WorkerResult {
  blob?: Blob;
  bitmap?: ImageBitmap;
  hash?: string;
  tileMeta?: TileMetadata;
}

export interface LayerItemForWorker {
  hash: string;
  boundingRect: Dimensions;
  visibleShape?: LocalShape;
  opacity: number;
  blendMode?: LayerBlendMode;
  fill?: number;
  /**
   * Layer type — forwarded from `Layer.type` so the Worker merger can
   * dispatch non-bitmap layers (color → fillRect) without a bitmap.
   * Defaults to `'image'` when absent (backward-compatible).
   * Phase 3: color layers skip bitmap lookup entirely; text still pre-rasterized.
   */
  type?: 'image' | 'color' | 'text';
  /**
   * Layer metadata — forwarded from `Layer.metadata` so the Worker merger
   * can access `fillColor` for color layers without a bitmap.
   */
  metadata?: { fillColor?: string; [key: string]: unknown };
  adjustments?: AdjustmentState;
  /**
   * Advanced tone-adjustment state (filter_pipeline_spec §5.1b.4).
   *
   * These three fields are forwarded to `worker/handlers/merger.ts`, where
   * the layer loop bakes them into the source ImageBitmap via
   * `Canvas2dFilter.apply(source, normalizeFilterDescriptors(...))` BEFORE
   * `EngineProvider.drawLayerInstance` runs. This is the ONE integration
   * point that gives PNG / JPG / AVIF / TIFF-8 / BMP / WebP filter-baked
   * output "for free" (spec §5.1b.5 responsibility table). Any missing
   * field on the exported layer produces an unfiltered output — every
   * producer site MUST copy these when it builds a `LayerItemForWorker`.
   *
   * Kept as optional plain JSON (not `Pick<Layer, ...>`) so producers
   * don't have to import the full Layer union just to satisfy the type.
   */
  curves?: CurvesState;
  levels?: LevelsState;
  channelMix?: ChannelMixState;
  colorBalance?: ColorBalanceState;
  vectorMasks?: VectorMask[];
  bitmapMasks?: BitmapMask[];
  matrix: {
    a: number; b: number; c: number; d: number; tx: number; ty: number;
  };
  dprScale?: number;
}

/**
 * AssetRef: Lightweight reference to a registered asset.
 * Returned by `assets.register()` and `PixelResult.toAsset()`.
 * Contains just enough info for callers to use the asset (set on layer, build visibleShape, etc.).
 */
export interface AssetRef {
  id: string;
  url: string;
  dimensions: { w: number; h: number };
}

/**
 * AssetEntryInfo: Public view of asset entry (excluding internal lifecycle states)
 */
export interface AssetEntryInfo {
  id: string;
  blob: Blob;
  url: string;
  state: string;
  tileMeta?: TileMetadata;
}

/**
 * AssetService: Physical asset management and lifecycle service (Domain: Assets)
 * Core responsibilities: Blob-to-Hash mapping, IDB storage, ObjectURL management, reference-counting GC.
 */
export interface AssetService {
  /** Registers asset: inputs Blob, returns AssetRef. Accepts optional rawBlob for 16-bit fidelity (Phase 5). */
  register: (blob: Blob, options?: { rawBlob?: Blob; dprScale?: number }) => Promise<AssetRef>;
  /** Injects asset: directly stores when hash and metadata are known, avoiding duplicate Worker calculations */
  inject: (hash: string, blob: Blob, tileMeta: TileMetadata) => Promise<string>;

  get: (id: string) => AssetEntryInfo | undefined;
  getURL: (id: string) => string | undefined;
  resolve: (assetId?: string, fallbackSrc?: string) => string;
  withSession: <T>(task: () => Promise<T>) => Promise<T>;
  sweep: (activeIds: Set<string>, force?: boolean) => void;
  hydrate: (activeIds?: Set<string>) => Promise<void>;
  clear: () => void;
  getPool: () => Record<string, AssetEntryInfo>;
  /** Phase 7.1: Wire lifecycle callbacks (engine layer subscribes to asset events) */
  setCallbacks: (callbacks: { onRegistered?: (hash: string, blob: Blob) => void; onReleased?: (hash: string) => void }) => void;
}

/**
 * WorkerProxy: Image processing proxy (Domain: Image Processing)
 * Core responsibilities: Acts as main thread proxy, scheduling Worker for heavy pixel calculations.
 */
export interface WorkerProxy {
  /** Flatten merge: synthesizes multiple layers into a new image */
  mergeLayersToLayer: (canvasDim: Dimensions, items: LayerItemForWorker[], options?: { targetDpr?: number }) => Promise<WorkerResult>;
  /** Bake mask: applies logical mask to physical pixels */
  bakeMasks: (assetId: string, masks: VectorMask[]) => Promise<WorkerResult>;
  /** Resample: adjusts image size in background */
  resampleImage: (src: string, targetSize: { w: number; h: number }, options?: { format?: string; quality?: number }) => Promise<WorkerResult>;
  /** Shape clip: clips multiple layers to specified shape and synthesizes new image */
  mergeLayersWithShape: (canvasDim: Dimensions, shape: LocalShape, items: LayerItemForWorker[], options?: { format?: string; quality?: number; targetDpr?: number }) => Promise<WorkerResult>;
  /**
   * Ensures asset blob is decoded in Worker cache and returns a WorkerResult (blob + hash + tileMeta).
   * options.hash: used directly as Worker cache key when provided; otherwise Worker computes it via HASH_ASSET.
   * Always stores the decoded bitmap mipmap in Worker LRU (for render-path assets).
   * For one-shot export blobs that should NOT enter LRU, use `computeBlobMetadata` instead.
   * Callers that only need the side-effect (cache warm-up) can ignore the return value.
   */
  ensureAssetInWorker: (blob: Blob, options?: { hash?: string }) => Promise<WorkerResult>;
  /**
   * Computes hash + TileMetadata for a one-shot blob WITHOUT storing anything in Worker LRU.
   * Use for Lane A/B vips export output — the blob is returned to the caller directly and
   * never rendered again, so LRU storage would only waste Worker memory.
   */
  computeBlobMetadata: (blob: Blob) => Promise<WorkerResult>;
  /** Transcodes TIFF blob to PNG raster via wasm-vips in Worker */
  transcodeTiff: (blob: Blob) => Promise<Blob>;
  /** Encodes RGBA ImageData to TIFF blob via wasm-vips in Worker */
  encodeTiff: (imageData: ImageData, options: { compression: string; dpi: number }) => Promise<Blob>;
}

/**
 * PixelService: Pixel facade service
 * Exposure of inspection (Eyes) and processing (Hands) capabilities.
 */
export interface PixelService {
  /**
   * Image namespace: decode, analyze, and cache bitmap assets.
   * Consolidates the former `decode`, `process.thumbnail`, and `cache.clear` into one cohesive surface.
   */
  image: {
    /**
     * Asynchronously load (decode) `src` into the shared main-thread
     * `ImageBitmap` cache and return it. Guaranteed to resolve with a
     * valid bitmap (or reject on decode failure).
     *
     * Flow: cache hit → return | in-flight dedup → share | miss → Worker DECODE job → cache → return.
     *
     * Callers must NOT close the returned bitmap; it is owned by
     * SourceBitmapCache and shared across every consumer (Canvas2dEngine,
     * BrushOverlay, ClipTool wand, Adjustment histogram, BgRemoval, …).
     */
    loadBitmap: (src: string) => Promise<ImageBitmap>;

    /**
     * Pre-warm the bitmap cache from a Blob you already hold in memory.
     * Decodes via the browser's internal thread pool (NOT Worker round-trip).
     *
     * Typical use: after bake/composite produces a new Blob, call this so
     * the next render frame hits cache immediately (no flash/flicker).
     */
    cacheBitmap: (src: string, blob: Blob) => Promise<void>;

    /**
     * Synchronous cache probe + background fetch trigger.
     *
     * - Cache hit → returns the `ImageBitmap` immediately (zero cost).
     * - Cache miss → returns `undefined` AND fires a background decode
     *   (fire-and-forget). Next call will likely hit cache.
     *
     * Use on gesture hot-paths (BrushOverlay mask init, render loop)
     * where `await` is not acceptable. Caller should degrade gracefully
     * when `undefined` is returned.
     */
    ensureBitmap: (src: string) => ImageBitmap | undefined;

    /**
     * Calculate the non-transparent content bounding box of an image.
     * If assetId with tileMeta.contentBounds is available, returns immediately
     * from metadata. Otherwise decodes and scans pixels.
     */
    contentBounds: (src: string, assetId?: string) => Promise<LocalRect>;

    /**
     * Extract raw RGBA pixel data via Worker (zero main-thread blocking).
     */
    imageData: (src: string, rect?: { x: number; y: number; w: number; h: number }) => Promise<ImageData>;

    /**
     * Compute full-resolution RGB composite histogram via Worker (zero main-thread blocking).
     * Returns a 256-bin Uint32Array (sum of per-channel R+G+B counts, matching
     * Photoshop's Levels dialog "RGB" channel histogram).
     */
    histogram: (assetId: string) => Promise<Uint32Array>;

    /**
     * Resample (resize) an image to the given target dimensions.
     * Delegates to the Worker for high-quality bicubic downsampling.
     *
     * Accepts either `targetSize` (exact dimensions) or `maxSize` (scale longest edge,
     * maintain aspect ratio). When `maxSize` is provided, `targetSize` is ignored.
     */
    resample: (src: string, options: { targetSize?: { w: number; h: number }; maxSize?: number }) => Promise<ResampleResult>;

    /**
     * Clear all bitmap caches (SourceBitmapCache).
     */
    clearCache: () => void;
  };

  render: {
    /**
     * compositeFrame — Composite a frame's visible layers within a given region.
     *
     * This is the standard entry point for "render the frame (or a sub-region of it)
     * as a flattened composite". Extracts visible layers from the frame, composites
     * them within the given ROI (defaults to full canvas if omitted).
     *
     * @param frame   - Target frame (provides layer graph + canvas size).
     * @param roi     - Region of interest (LocalShape). Defaults to the full canvas if omitted.
     * @param options - { precision?: 8 | 16, dpr?: number }
     * @returns CompositeResult — consume via toAsset() / toBlob() etc. GC handles cleanup.
     */
    compositeFrame: (frame: Frame, roi?: LocalShape, options?: { precision?: 8 | 16; dpr?: number }) => Promise<CompositeResult>;
    /**
     * compositeLayers — Computes the union bounding shape of the given layers,
     * composites them via the unified pipeline at the specified frame bit depth,
     * and returns the CompositeResult along with the computed union geometry.
     *
     * When `roi` is provided, it is used as the composite region directly
     * (the effective output is the intersection of layer pixels and roi).
     * When omitted, the union bounding of all layers is used as the roi.
     *
     * Callers consume the result via `result.toAsset()`, `result.toBlob()`, etc.
     * GC handles cleanup — no explicit dispose needed.
     */
    compositeLayers: (layers: Layer[], frame: Frame, roi?: Shape, options?: { precision?: 8 | 16; dpr?: number }) => Promise<{
      result: CompositeResult;
      bounds: { w: number; h: number; cx: number; cy: number };
    }>;
    /**
     * compositeResizedLayers — Composites the given layers at their natural bounds,
     * then outputs at the specified `outputSize` (single Worker round-trip).
     *
     * Use this when you need to bake + scale in one step (e.g. non-uniform resample).
     * Unlike `compositeLayers`, this method does NOT accept an roi parameter —
     * it always uses the union bounding of all layers as the composite region.
     */
    compositeResizedLayers: (
      layers: Layer[],
      frame: Frame,
      outputSize: { w: number; h: number },
    ) => Promise<{
      result: CompositeResult;
    }>;
    /**
     * Registers an external encoder for a MIME type that FileService does not natively support
     * (e.g. AVIF, which physically lives in a plugin worker).
     * When the composite pipeline encounters a matching `format`, it delegates to the registered encoder.
     * Returns a disposer.
     */
    registerEncoder: (
      mimeType: string,
      encoder: (bitmap: ImageBitmap, options: { quality?: number; metadata?: ImageMetadata }) => Promise<Blob>,
    ) => () => void;
  };

  utils: {
    fetchFromUrl: (url: string) => Promise<File>;
    download: (blob: Blob, filename: string) => Promise<void>;
  };

  rasterize: {
    /** Rasterizes any layer to bitmap Asset (text -> fillText, color -> fillRect, image -> flatten masks/adjustments).
     *  Accepts optional opts.dpr to control output resolution (Phase 4 DPR unification). */
    layer: (layer: Layer, opts?: { dpr?: number }) => Promise<{ id: string; url: string }>;
    /** Rasterizes a polygon selection into a grayscale mask PNG asset (white=visible, black=hidden) */
    mask: (polygon: LocalPolygon, bounds: { w: number; h: number }, feather?: number) => Promise<{ id: string; url: string } | null>;
  };


  /**
   * File I/O operations delegated to the unified vips Worker.
   * Replaces tiff.ts self-managed VipsWorker (Phase 7.2 vips unification).
   */
  fileIO: {
    decodeTiff: (bytes: Uint8Array, options?: { preserveColorSpace?: boolean }) => Promise<{ width: number; height: number; data: Uint8Array }>;
    encodeTiff: (rgbaData: Uint8Array, width: number, height: number, options: Record<string, unknown>) => Promise<Uint8Array>;
    getPageCount: (bytes: Uint8Array) => Promise<{ pages: number; pageWidth: number; pageHeight: number }>;
    decodePage: (bytes: Uint8Array, page: number) => Promise<{ width: number; height: number; data: Uint8Array }>;
    composite16bit: (params: {
      layers: Array<{
        bytes: Uint8Array;
        x: number;
        y: number;
        blendMode: string;
        opacity: number;
        is8bit: boolean;
        adjustments?: Record<string, unknown>;
      }>;
      canvasWidth: number;
      canvasHeight: number;
      options: Record<string, unknown>;
    }) => Promise<Uint8Array>;
    exportHighRes: (rawBytes: Uint8Array, options: Record<string, unknown>) => Promise<Uint8Array>;
    /** Convert image bytes with non-sRGB ICC profile to sRGB RGBA pixel data via vips (Little CMS). Also returns raw ICC profile bytes for round-trip export. */
    iccToSrgb: (bytes: Uint8Array) => Promise<{ width: number; height: number; data: Uint8Array; iccProfileData?: Uint8Array }>;
    /** Convert sRGB RGBA pixels back to target ICC color space via vips (Little CMS). Used for export round-trip. */
    srgbToIcc: (rgbaData: Uint8Array, width: number, height: number, iccProfileData: Uint8Array) => Promise<{ data: Uint8Array }>;
    /** Encode RGBA pixels to AVIF format via vips-heif (libheif + libaom). */
    encodeAvif: (rgbaData: Uint8Array, width: number, height: number, options: { quality?: number; lossless?: boolean; effort?: number; iccProfileBytes?: Uint8Array; bitDepth?: number; dpi?: number }) => Promise<Uint8Array>;
  };

  /**
   * Unified composite pipeline entry point.
   *
   * Replaces the old lane-detection logic (render.flatten / shapeToBlob / flattenLayers / worker.mergeLayersWithShape).
   * Callers describe "what to compose" via a CompositeRequest; the pipeline internally resolves
   * strategies, selects the best backend (8-bit Canvas2D / 16-bit vips / future WebGPU),
   * and returns a lazy CompositeResult.
   *
   * @see docs/opengpex/plans/20260721_unified_composite_pipeline_design.md §14 Step 7
   */
  composite: (request: CompositeRequest) => Promise<CompositeResult>;
}

/**
 * StateStorage: Editor state (JSON) persistence service (Domain: Persistence)
 */
export interface StateStorage {
  save: (state: EditorData) => Promise<void>;
  restore: () => Promise<EditorData | null>;
  gc: (state: EditorData, force?: boolean) => Promise<void>;
  clear: () => Promise<void>;

  /** Exports artboards to portable serialized form (dehydration + asset collection) */
  export: (frame: Frame) => Promise<{ state: unknown; assets: Record<string, Blob> }>;
  /** Imports and hydrates artboard from serialized form (assuming assets already injected in AssetService) */
  import: (state: unknown) => Frame;
}

/**
 * ClipboardLayerMetadata: Clipboard layer metadata protocol
 */
export interface ClipboardLayerMetadata {
  assetId?: string;
  src?: string;
  name?: string;
  w?: number;
  h?: number;
  visibleShape?: LocalShape;
  scale?: number;
  rotation?: number;
  flip?: { h: boolean; v: boolean };
  originalCx?: number;
  originalCy?: number;
  /** Direct carriage of complete layer object on internal paste */
  layer?: Layer;
  /** Frame ID where the copy originated — used to detect cross-frame paste */
  sourceFrameId?: string;
}

/**
 * ClipboardService: System clipboard interaction driver (without business logic)
 */
export interface ClipboardService {
  /** Writes to system clipboard (Blob + metadata) */
  writeBlob: (blob: Blob, metadata: ClipboardLayerMetadata) => Promise<void>;
  /** Writes to system clipboard (downloaded via URL then written) */
  writeByUrl: (url: string, metadata: ClipboardLayerMetadata) => Promise<void>;
  /** Reads data from system clipboard */
  read: (e?: ClipboardEvent) => Promise<{ blob?: Blob; metadata?: ClipboardLayerMetadata } | null>;
}


export * from '../layer/types';

