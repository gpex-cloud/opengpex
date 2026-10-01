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

import type { CompositeRequest, CompositedImage, ResampledImage, SampledPixels, GpuInfo } from '../engine/types';

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
  LocalRect, Dimensions, Shape, LocalShape, WorldShape, GamutId, Rect
} from './primitives';
import { EditorData } from './state';
import type { ImageMetadata, EncodeSource } from '../files/types';
import type { ImageAssetPayload } from '../storage/asset/AssetStore';
import type { ColorIdentity, AssetEntry } from '../storage/asset/AssetStore';
import type { InMemAsset, AssetInputOptions, AssetBundle } from '../storage/asset/AssetService';
import type { GpexAssetManifest } from '../helpers/gpex-format';

export type { ColorIdentity, AssetEntry, InMemAsset, AssetInputOptions, AssetBundle };

// ═══════════════════════════════════════════════════════════════════════════
// Frame command contracts — .gpex project container
//
// The payload/result shapes of `adv.gpex.pack` / `adv.gpex.unpack`. They live
// here, not next to the command implementation, because `types/actions.ts` and
// `state/useEditorStore.ts` both need them and neither may import upwards from
// `core/advanced/commands/*`.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * FrameExportResult — what `StateStorage.export` hands the .gpex container
 * writer. Beyond the 8-bit display blobs it carries everything needed to
 * reproduce the project losslessly:
 *   - `assets`     display bitmaps keyed by AUTHORITATIVE asset id;
 *   - `manifest`   per-asset geometry + colour identity + provenance;
 *   - `rawBlobs`   category-② source files, keyed (and thereby deduplicated)
 *                  by content hash — a multi-page import ships one copy;
 *   - `decBuffers` category-③ bake products' naked high-depth pixels, keyed by
 *                  asset id; nothing else can regenerate those.
 */
export interface FrameExportResult {
  state: unknown;
  assets: Record<string, Blob>;
  manifest: GpexAssetManifest;
  rawBlobs: Record<string, Blob>;
  decBuffers: Record<string, Uint16Array | Float32Array>;
}

/**
 * FrameUnpackPayload — the full contents of a .gpex payload ZIP, as consumed
 * by the `adv.gpex.unpack` command. Everything past `assetBlobs` is optional
 * so legacy containers (state.json + assets/ only) still load.
 */
export interface FrameUnpackPayload {
  state: unknown;
  /** `assets/{id}` — 8-bit display bitmaps, keyed by AUTHORITATIVE asset id. */
  assetBlobs: Record<string, Blob>;
  /** `raw/{fileHash}` — original source files, deduplicated by content hash. */
  rawBlobs?: Record<string, Blob>;
  /** `dec/{id}.bin` — bake products' naked high-depth pixels. */
  decBuffers?: Record<string, Uint16Array | Float32Array>;
  /** `assets-manifest.json` — absent in legacy containers. */
  manifest?: GpexAssetManifest;
  replaceId?: string;
  switchFrame?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Frame command contracts — export to file
//
// The payload/result shapes of `adv.frame.export.encode`. `FrameExportEncode-
// Config` is the core half of the plugin-local `ExportConfig`
// (ImageInfoDrawer/protocols.ts), which `extends` it with UI-only fields; a
// caller passes its own config object as-is and core never imports a plugin
// type. Keep it FLAT — one interface, fields grouped by comment section — so
// the value shape stays a plain bag the encoder can read directly.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Encode-time export config. A new format's knobs get their own comment
 * section below; every field here must be forwarded by
 * `commands/frame/export.ts` or it is silently dropped before the encoder.
 */
export interface FrameExportEncodeConfig {
  // ─── Container — apply to every output format ─────────────────────────
  /** Output MIME type, e.g. `'image/png'`. */
  format: string;
  /** 0-100 UI slider; the JPEG/WebP/AVIF CONTAINER quality. */
  quality?: number;
  /** Carry the source's EXIF block into the output. */
  keepExif?: boolean;
  /** Pending DPI override; `0`/omitted = use the frame's own dpi. */
  dpi?: number;

  // ─── Colour — drives the egest decision and ICC attachment ────────────
  /**
   * Desired OUTPUT gamut. When omitted the command defaults it to the
   * DOCUMENT's own gamut, which keeps plain sRGB docs on the identity path.
   */
  targetGamut?: GamutId;
  /** PNG/TIFF output bit depth; defaults to 16 when the source is high-depth. */
  exportBitDepth?: 8 | 16;
  /** Force-embed (or force-suppress) the ICC profile, overriding the decision. */
  embedIccOverride?: boolean;

  // ─── TIFF — read only when `format === 'image/tiff'` ──────────────────
  tiffCompression?: 'none' | 'lzw' | 'zip' | 'jpeg';
  /**
   * Quality (1-100) of the JPEG codec INSIDE a TIFF; only used when
   * `tiffCompression === 'jpeg'`. Distinct from `quality`, which is the
   * container quality of a standalone JPEG/WebP/AVIF.
   */
  tiffJpegQuality?: number;
  tiffPredictor?: 'none' | 'horizontal' | 'float';
  /** Emit a BigTIFF (64-bit offsets) instead of classic TIFF. */
  tiffBigtiff?: boolean;
  /** Write tiled rather than stripped layout. */
  tiffTile?: boolean;
  tiffTileWidth?: number;
  tiffTileHeight?: number;

  // ─── PNG — read only when `format === 'image/png'` ────────────────────
  /** Deflate level: 0 = none/fastest, 6 = default, 9 = max/slowest. */
  pngCompression?: 0 | 6 | 9;
}

// ─── Export command payload / result ───────────────────────────────────────

export interface FrameExportEncodePayload {
  exportWidth: number;
  exportHeight: number;
  /** Clip rect (world/local); undefined = the full frame. */
  region?: Rect;
  config: FrameExportEncodeConfig;
}

export interface FrameExportEncodeResult {
  blob: Blob;
  filename: string;
}

export interface WorkerResult {
  blob?: Blob;
  bitmap?: ImageBitmap;
  hash?: string;
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
  /** Layer metadata — forwarded from `Layer.metadata`. */
  metadata?: { [key: string]: unknown };
  adjustments?: AdjustmentState;
  /**
   * Advanced tone-adjustment state (filter_pipeline_spec §5.1b.4).
   *
   * These three fields are forwarded to `worker/handlers/merger.ts` so the export
   * layer loop can reproduce the on-screen grade. Any missing field on the
   * exported layer produces an unfiltered output — every producer site MUST copy
   * these when it builds a `LayerItemForWorker`.
   *
   * ⚠️ v2 status: the ON-SCREEN grade is evaluated on the GPU (`adjust.wgsl`, §9.3)
   * from `AdjustmentDesc[]`, not by any CPU descriptor chain. These fields remain
   * the EXPORT-side carrier only; unifying export onto the same compiled
   * RenderGraph (so "preview === export" is structural rather than reproduced) is
   * Phase 4 §11.
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
  assetId: string;
  url: string;
  dimensions: { w: number; h: number };
}

/**
 * AssetInfo: Public read-only view of an in-memory asset (excludes GC-private
 * state — `owners`, `lastUsedAt`). Renamed from `AssetEntryInfo` — `Entry` +
 * `Info` was a redundant doubled suffix. Extends the shared `AssetEntry` base
 * (geometry + colour identity + display blob), so consumers of this DTO see
 * the same colour identity as the persisted and in-memory shapes.
 */
export interface AssetInfo extends AssetEntry {
  url: string;
  state: string;
}

/**
 * AssetService: Physical asset management and lifecycle service (Domain: Assets)
 * Core responsibilities: Blob-to-Hash mapping, IDB storage, ObjectURL management, reference-counting GC.
 */
export interface AssetService {
  /** Registers asset: computes content hash, creates an InMemAsset, and persists a StoredAsset. Always triggers rendering cache pre-warm. */
  register: (blob: Blob, options: AssetInputOptions) => Promise<AssetRef>;
  /** Stores a raw source blob, returns its content hash. Returns undefined if rawBlob is null/undefined. */
  storeRaw: (rawBlob: Blob | undefined | null) => Promise<string | undefined>;
  /**
   * Persists the DECODED high-depth naked pixels (bare f16 `Uint16Array`) under
   * `dec:${assetId}`. Bake products (`PixelResult.toAsset`) / high-depth imports
   * use it so a cold reload/revert can warm the high-depth cache directly
   * (bypassing vips). Geometry + colour identity are NOT stored here — they
   * belong to the light `StoredAsset` (the sole owner); only the irreducible
   * pixel bytes live under `dec:`.
   *
   * §6.4 write ordering: persist `dec:` (heavy) BEFORE writing the light record's
   * `dataFormat`, so the predicate never claims a truth not yet on disk.
   *
   * `data` is the bare TypedArray whose element type matches the light record's
   * `dataFormat`: `Uint16Array` for `rgba16float`, `Float32Array` for a true
   * 32-bit float source (`rgba32float`, §6.5).
   */
  storeDec: (assetId: string, data: Uint16Array | Float32Array) => Promise<void>;
  /** Reads a raw source blob (original imported file) by id, or null. Facade over the storage singleton (symmetry with storeRaw). */
  getRaw: (id: string) => Promise<Blob | null>;
  /**
   * Reads the persisted decoded high-depth naked pixels (a bare TypedArray) by
   * id, or null (symmetry with storeDec). The caller reassembles a
   * `HighDepthSource` using geometry + colour identity from the light
   * `StoredAsset` — including which of the two element types this is, via
   * `dataFormat`; a `null` here when `dataFormat` said a truth should exist is a
   * persist failure / mis-GC to warn on, not a silent degrade.
   */
  getDec: (id: string) => Promise<Uint16Array | Float32Array | null>;
  /**
   * Injects asset: directly stores under a caller-provided id (PixelResult bake
   * output, or a high-depth import repointing its base layer at the source hash),
   * bypassing hash calculation. Takes the same `AssetInputOptions` shape as
   * `register` and returns the same `AssetRef` shape — full signature symmetry
   * between the two registration paths.
   */
  inject: (assetId: string, blob: Blob, options: AssetInputOptions) => Promise<AssetRef>;
  /**
   * One-shot ingest of a single image asset payload (the Golden Path): register
   * the display asset, store the shared raw source blob, and warm the high-depth
   * cache if the payload carries pre-decoded naked pixels. Takes the general
   * `ImageAssetPayload` contract — both file-decode's `DecodedImage` (which
   * extends it) and engine composite bake's `CompositedImage` converge on this
   * one call. `sourceBlob` is shared across all pages of a multi-page decode —
   * pass it once (e.g. only on the first page) to avoid redundant re-hashing.
   */
  storeBundle: (page: ImageAssetPayload, sourceBlob?: Blob | null) => Promise<AssetBundle>;

  get: (assetId: string) => InMemAsset | undefined;
  getURL: (assetId: string) => string | undefined;
  resolve: (assetId?: string, fallbackSrc?: string) => string;
  withSession: <T>(task: () => Promise<T>) => Promise<T>;
  sweep: (activeIds: Set<string>, force?: boolean) => void;
  hydrate: (activeIds?: Set<string>) => Promise<void>;
  clear: () => void;
  getPool: () => Record<string, InMemAsset>;
  /** Phase 7.1: Wire lifecycle callbacks (engine layer subscribes to asset events) */
  setCallbacks: (callbacks: { onRegistered?: (assetId: string, blob: Blob) => void; onReleased?: (assetId: string) => void }) => void;
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
   * Ensures asset blob is decoded in Worker cache and returns a WorkerResult (blob + hash).
   * options.hash: used directly as Worker cache key when provided; otherwise Worker computes it via HASH_ASSET.
   * Always stores the decoded bitmap mipmap in Worker LRU (for render-path assets).
   * For one-shot export blobs that should NOT enter LRU, use `computeBlobMetadata` instead.
   * Callers that only need the side-effect (cache warm-up) can ignore the return value.
   */
  ensureAssetInWorker: (blob: Blob, options?: { hash?: string }) => Promise<WorkerResult>;
  /**
   * Computes hash for a one-shot blob WITHOUT storing anything in Worker LRU.
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
     * SourceBitmapCache and shared across every consumer (render engine,
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
     * Decodes and scans pixels.
     */
    contentBounds: (src: string) => Promise<LocalRect>;

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
     * Accepts `targetSize` (exact dimensions), `maxSize` (scale longest edge,
     * maintain aspect ratio), or `scale` (uniform factor applied to the source's
     * TRUE pixel dimensions). When `maxSize` is provided, `targetSize` is ignored;
     * when `scale` is provided, `targetSize` is ignored (but `maxSize` still wins).
     *
     * `sourceGamut` (optional) is the source's gamut, resolved by the caller from
     * its light asset record — threaded to the Worker so the OffscreenCanvas
     * colorSpace matches instead of defaulting to sRGB and clamping wide-gamut sources.
     */
    resample: (src: string, options: { targetSize?: { w: number; h: number }; maxSize?: number; scale?: number; sourceGamut?: GamutId }) => Promise<ResampledImage>;

    /**
     * Clear all bitmap caches (SourceBitmapCache).
     */
    clearCache: () => void;

    /**
     * Return a caller-owned clone of a cached bitmap, safe for postMessage transfer.
     * Near-zero cost (GPU-side refcount, NOT full re-decode).
     * Returns null if the src is not in cache.
     */
    acquireOwned: (src: string) => Promise<ImageBitmap | null>;

    /**
     * Write a pre-decoded ImageBitmap directly into the cache.
     * Use when caller already holds a decoded bitmap (e.g. from Worker transfer).
     * Skips the blob→decode round-trip that cacheBitmap() performs.
     */
    writeBitmap: (src: string, bitmap: ImageBitmap) => void;
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
     * @returns CompositedImage — pass to `assets.storeBundle()` to persist.
     */
    compositeFrame: (frame: Frame, roi?: LocalShape) => Promise<CompositedImage>;
    /**
     * compositeLayers — Computes the union bounding shape of the given layers
     * (or uses `roi` when provided) and composites them via the unified pipeline.
     *
     * When `roi` is provided, it is used as the composite region directly
     * (the effective output is the intersection of layer pixels and roi).
     * When omitted, the union bounding of all layers is used as the roi.
     */
    compositeLayers: (layers: Layer[], frame: Frame, roi?: Shape) => Promise<CompositedImage>;
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
    ) => Promise<CompositedImage>;
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
    /**
     * capture — Pure-memory pixel snapshot (proposal §3.2): the WebGPU colour
     * sampler / mosaic hot path. Shares the composite GPU-readback core but SKIPS
     * `canvasToBlob`/`blobToImageData` AND the terminal encode, returning the raw
     * premultiplied-linear working-gamut readback (`linearPixels`). Callers decode
     * the region they care about with `engine/utils/sample-utils.ts::sampleGpuRawData`
     * — encoding the whole ROI up front cost 1.3s per 16MP capture. No persistence.
     *
     * @param frame       Document frame (supplies `assetId` for gamut arbitration).
     * @param opts.roi    World-space coverage region. Defaults to the full artboard.
     * @param opts.layers Layer subset. Defaults to all visible, non-group, non-host
     *                    layers (mirrors `compositeFrame`); a single layer yields
     *                    "current layer" sampling.
     * @param opts.scale  Snapshot texels per world pixel (default 1 = document
     *                    pixels). `min(1, camera.k)` snapshots at DISPLAY
     *                    resolution — coverage equals the viewport at any zoom for
     *                    a viewport-sized cost. Read it back off `result.scale`.
     */
    capture: (
      frame: Frame,
      opts?: { roi?: WorldShape; layers?: Layer[]; scale?: number },
    ) => Promise<SampledPixels>;
    /**
     * renderForExport — Render `request.frame` on the SAME WebGPU pipeline the
     * on-screen preview uses (ONE PIPELINE EQUIVALENCE) and return an
     * `EncodeSource` ready for `files.encode()`.
     *
     * Unlike `compositeFrame`/`compositeLayers` (internal layer-subset bake,
     * no format/ICC axis), this is the EXPORT-TO-FILE path: the caller has
     * already resolved the egest decision (`core/files/strategy/egest.ts`) and
     * passes its `targetGamut` / `channel` / `canvasColorSpace` fields straight
     * through — this method does no colour decision-making of its own, only the
     * GPU readback + terminal gamut encode. The readback's own (source) gamut is
     * the engine invariant `WORKING_GAMUT` and is therefore not a parameter.
     */
    renderForExport: (request: {
      frame: Frame;
      viewportDim: Dimensions;
      targetWidth: number;
      targetHeight: number;
      region?: Rect;
      targetGamut: GamutId;
      channel: 'canvas-8' | 'raw-8' | 'raw-16';
      canvasColorSpace: PredefinedColorSpace;
    }) => Promise<EncodeSource>;
  };

  utils: {
    download: (blob: Blob, filename: string) => Promise<void>;
  };

  /**
   * System namespace: read-only engine/device diagnostics.
   */
  system: {
    /**
     * Synchronous GPU diagnostics snapshot: adapter identity + allocation-ceiling
     * limits + engine memory book-keeping (pool + composite target). Returns
     * `{ ready:false, … }` with placeholder statics before the engine is `init`ed.
     *
     * ⚠️ WebGPU has NO "true VRAM total" API: `limits` are allocation
     * ceilings and `memory` is the engine's OWN accounting — NEITHER is a real
     * hardware-memory figure. See {@link GpuInfo}. Do not present as "VRAM usage".
     */
    gpuInfo: () => GpuInfo;
  };

  rasterize: {
    /** Rasterizes any layer to bitmap Asset (text -> fillText, color -> fillRect, image -> flatten masks/adjustments).
     *  Accepts optional opts.dpr to control output resolution. */
    layer: (layer: Layer, opts?: { dpr?: number }) => Promise<{ assetId: string; url: string }>;
  };


  /**
   * Unified composite pipeline entry point.
   *
   * Replaces the old lane-detection logic (render.flatten / shapeToBlob / flattenLayers / worker.mergeLayersWithShape).
   * Callers describe "what to compose" via a CompositeRequest; the pipeline internally resolves
   * the document-anchored gamut and auto-adaptive precision (§2.4) and returns a plain-data
   * CompositedImage — pass it to `assets.storeBundle()` to persist.
   *
   */
  composite: (request: CompositeRequest) => Promise<CompositedImage>;
}

/**
 * StateStorage: Editor state (JSON) persistence service (Domain: Persistence)
 */
export interface StateStorage {
  save: (state: EditorData) => Promise<void>;
  restore: () => Promise<EditorData | null>;
  gc: (state: EditorData, force?: boolean) => Promise<void>;
  clear: () => Promise<void>;

  /**
   * Exports artboards to portable serialized form (dehydration + asset
   * collection). Beyond the display blobs this yields the per-asset manifest
   * plus the category-②/③ heavy payloads (`rawBlobs` / `decBuffers`) that make
   * the container a lossless snapshot — see `FrameExportResult`.
   */
  export: (frame: Frame) => Promise<FrameExportResult>;
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

