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

import { Frame, Layer, AdjustmentState, VectorMask, BitmapMask } from './models';
import {
  LocalRect, Dimensions, ClipDescriptor,
  Shape, LocalShape, LocalPolygon, ShapeType, TileMetadata
} from './primitives';
import { EditorData, EngineStatus, SupportedImageFormat } from './state';

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
  /** Registers asset: inputs Blob, returns Hash */
  register: (blob: Blob, dprScale?: number) => Promise<string>;
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
  /** Transcodes SVG blob to PNG raster via resvg-wasm in Worker */
  transcodeSvg: (blob: Blob, maxDimension?: number) => Promise<Blob>;
}

/**
 * PixelService: Pixel facade service
 * Exposure of inspection (Eyes) and processing (Hands) capabilities.
 */
export interface PixelService {
  decode: {
    htmlImage: (src: string) => Promise<HTMLImageElement>;
    dimensions: (src: string, assetId?: string) => Promise<Dimensions>;
    contentBounds: (src: string, assetId?: string) => Promise<LocalRect>;
  };

  process: {
    thumbnail: (source: HTMLImageElement | string, maxSize?: number) => Promise<Blob>;
    resample: (src: string, options: { targetSize: { w: number; h: number } }) => Promise<Blob>;
    /** Pre-transcodes non-standard formats (HEIC, SVG) to engine-compatible raster before asset registration */
    preTranscode: (file: File) => Promise<File>;
  };

  render: {
    /** Area flatten: synthesizes layers within specified region into a new image */
    shapeToBlob: (frame: Frame, shape: LocalShape, options?: { format?: string; quality?: number }) => Promise<Blob | ImageBitmap>;
    frameToBlob: (frame: Frame, options?: { format?: string; quality?: number }) => Promise<Blob | ImageBitmap>;
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
    detectFormat: (file: File) => SupportedImageFormat;
    fetchFromUrl: (url: string) => Promise<File>;
    download: (blob: Blob, filename: string) => Promise<void>;
    probeEngines: () => EngineStatus[];
    getExportFilename: (name: string, w: number, h: number, ext: string) => Promise<string>;
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

