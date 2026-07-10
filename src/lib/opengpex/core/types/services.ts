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

import { Frame, Layer, AdjustmentState, VectorMask, BitmapMask, LayerBlendMode } from './models';
import {
  LocalRect, Dimensions, ClipDescriptor,
  Shape, LocalShape, LocalPolygon, ShapeType, TileMetadata
} from './primitives';
import { EditorData, EngineStatus } from './state';
import type { ImageMetadata } from '../files/types';

/**
 * RenderToBlobOptions: Unified options for PixelService.render.frameToBlob / shapeToBlob.
 *
 * This options bag expresses "what does the user want" (format / bit depth / metadata / quality / exportConfig)
 * so that the PixelService facade can decide "which backend/encoder to route to" internally.
 *
 * Note: There is NO `cropBox` field — cropping is always expressed via the `shape` parameter
 * of shapeToBlob (frameToBlob is a sugar that supplies a full-canvas rect shape).
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
}

/**
 * Pluggable AVIF encoder — injected by the host into PixelService.
 * PixelService itself is format-agnostic; the AVIF encoder lives in a plugin (uses its own worker).
 * TODO: fold AVIF into core FileService as a first-class handler; see §9.1 of export refactor proposal.
 */
export type AvifEncoder = (bitmap: ImageBitmap, options: { quality?: number }) => Promise<Blob>;


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
  adjustments?: AdjustmentState;
  vectorMasks?: VectorMask[];
  bitmapMasks?: BitmapMask[];
  matrix: {
    a: number; b: number; c: number; d: number; tx: number; ty: number;
  };
  dprScale?: number;
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
  /** Registers asset: inputs Blob, returns Hash. Accepts optional rawBlob for 16-bit fidelity (Phase 5). */
  register: (blob: Blob, options?: { rawBlob?: Blob; dprScale?: number }) => Promise<string>;
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
}

/**
 * WorkerProxy: Image processing proxy (Domain: Image Processing)
 * Core responsibilities: Acts as main thread proxy, scheduling Worker for heavy pixel calculations.
 */
export interface WorkerProxy {
  /** Flatten merge: synthesizes multiple layers into a new image */
  mergeLayersToLayer: (canvasDim: Dimensions, items: LayerItemForWorker[], options?: { targetDpr?: number }) => Promise<WorkerResult>;
  /** Clone clip: clips region from specified asset */
  cloneRegion: (assetId: string, rect: LocalRect, shape?: ShapeType) => Promise<WorkerResult>;
  /** Bake mask: applies logical mask to physical pixels */
  bakeMasks: (assetId: string, masks: VectorMask[]) => Promise<WorkerResult>;
  /** Resample: adjusts image size in background */
  resampleImage: (src: string, targetSize: { w: number; h: number }, options?: { format?: string; quality?: number }) => Promise<WorkerResult>;
  /** Shape clip: clips multiple layers to specified shape and synthesizes new image */
  mergeLayersWithShape: (canvasDim: Dimensions, shape: LocalShape, items: LayerItemForWorker[], options?: { format?: string; quality?: number; targetDpr?: number }) => Promise<WorkerResult>;
  /** Ensures asset blob is decoded in Worker cache (used for bitmapMask etc. which are only rendered in main thread) */
  ensureAssetInWorker: (hash: string, blob: Blob) => Promise<void>;
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
  decode: {
    /**
     * Decode `src` into the shared main-thread `ImageBitmap` cache
     * and return it. Callers must NOT close the returned bitmap; it
     * is owned by SourceBitmapCache and shared across every consumer
     * (Canvas2dEngine, BrushOverlay, ClipTool wand, ColorGrading
     * histogram, BgRemoval, …).
     *
     * If you need a Worker-transferable clone, use
     * `sourceBitmapCache.acquireOwned(src)` instead.
     */
    bitmap: (src: string) => Promise<ImageBitmap>;
    dimensions: (src: string, assetId?: string) => Promise<Dimensions>;
    contentBounds: (src: string, assetId?: string) => Promise<LocalRect>;
  };

  process: {
    thumbnail: (src: string, maxSize?: number) => Promise<Blob>;
    resample: (src: string, options: { targetSize: { w: number; h: number } }) => Promise<Blob>;
  };

  render: {
    /**
     * Area flatten: renders the region of `frame` matching `shape` and encodes it.
     * When `options.format === 'raw'` returns an ImageBitmap; otherwise returns a Blob.
     * Internally chooses between the 16-bit vips lane and the 8-bit engine-worker lane.
     */
    shapeToBlob: (frame: Frame, shape: LocalShape, options?: RenderToBlobOptions) => Promise<Blob | ImageBitmap>;
    /**
     * Sugar over `shapeToBlob(frame, fullRectShapeOfFrame, options)`.
     * Renders the entire frame's visible canvas region.
     */
    frameToBlob: (frame: Frame, options?: RenderToBlobOptions) => Promise<Blob | ImageBitmap>;
    /**
     * Registers an external encoder for a MIME type that FileService does not natively support
     * (e.g. AVIF, which physically lives in a plugin worker).
     * When lane C encounters a matching `format`, it delegates to the registered encoder.
     * Returns a disposer.
     */
    registerEncoder: (
      mimeType: string,
      encoder: (bitmap: ImageBitmap, options: { quality?: number; metadata?: ImageMetadata }) => Promise<Blob>,
    ) => () => void;
  };



  worker: {
    /** 
     * Incremental merge: overlays layers from items list sequentially on top of target layer.
     * Target layer automatically participates in synthesis as background base map.
     */
    mergeLayersToLayer: (target: Layer, items: (Layer | { layer: Layer; relative?: boolean })[], options?: { targetDpr?: number }) => Promise<WorkerResult>;
    cloneRegion: (assetId: string, rect: LocalRect, shape?: ShapeType) => Promise<WorkerResult>;
    bakeMasks: (assetId: string, masks: VectorMask[]) => Promise<WorkerResult>;
    /** Resample: adjusts image size in background */
    resampleImage: (src: string, targetSize: { w: number; h: number }, options?: { format?: string; quality?: number }) => Promise<WorkerResult>;
    /** Shape clip: clips multiple layers to specified shape and synthesizes new image */
    mergeLayersWithShape: (layers: Layer[], shape: Shape, options?: { format?: string; quality?: number; targetDpr?: number }) => Promise<WorkerResult>;
    /** Wraps Worker raw result and registers as asset */
    asAsset: (promise: Promise<WorkerResult>) => Promise<{ id: string, url: string }>;
  };

  utils: {
    getRenderPipeline: (layer: Layer) => ClipDescriptor[];
    fetchFromUrl: (url: string) => Promise<File>;
    download: (blob: Blob, filename: string) => Promise<void>;
    probeEngines: () => EngineStatus[];
  };

  rasterize: {
    /** Rasterizes any layer to bitmap Asset (text -> fillText, color -> fillRect, image -> flatten masks/adjustments) */
    layer: (layer: Layer) => Promise<{ id: string; url: string }>;
    /** Rasterizes a polygon selection into a grayscale mask PNG asset (white=visible, black=hidden) */
    mask: (polygon: LocalPolygon, bounds: { w: number; h: number }, feather?: number) => Promise<{ id: string; url: string } | null>;
  };

  cache: {
    clear: () => void;
  };
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

