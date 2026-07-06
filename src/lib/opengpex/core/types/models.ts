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
 * Model Types: Editor core business model definitions
 */
import { Dimensions, LocalShape, LocalRect, LocalPolygon } from './primitives';

export type RenderEngine = 'canvas' | 'webgpu';
export const LAYER_ROLES = ['host', 'frag', 'exchange'] as const;
export type LayerRole = typeof LAYER_ROLES[number];

export interface NormalizedState<T> {
  byId: Record<string, T>;
  order: string[];
}

export interface ExifData {
  Make?: string;
  Model?: string;
  DateTimeOriginal?: string;
  FNumber?: number;
  ExposureTime?: number;
  ISOSpeedRatings?: number;
  FocalLength?: number;
  LensMake?: string;
  LensModel?: string;
  Software?: string;
  ColorSpace?: number;
  XResolution?: number;
  YResolution?: number;
  ResolutionUnit?: number;
  CreateDate?: string;
  DateTimeDigitized?: string;
  ModifyDate?: string;
  ExifVersion?: string;
  WhiteBalance?: string;
  rawPiexifObj?: Record<string, unknown>;
  /** ICC Profile embedded indicator */
  hasIccProfile?: boolean;
  /** ICC Profile description name (e.g. "sRGB IEC61966-2.1", "Adobe RGB (1998)") */
  iccProfileName?: string;
  /** Color space string from ImageMetadata (e.g. 'srgb', 'adobe-rgb', 'display-p3') */
  colorSpaceName?: string;
}

export interface AdjustmentState {
  brightness: number; // 0-200, default 100
  contrast: number;   // 0-200, default 100
  saturation: number; // 0-200, default 100
  hueRotate: number;  // 0-360, default 0
  blur: number;       // 0-20, default 0
}

export interface VectorMask {
  id: string;
  shape: LocalShape;          // Shape descriptor (local coordinate system)
  inverted: boolean;               // Whether to invert mask
  feather: number;                 // Feather radius (px)
  enabled: boolean;                // Whether enabled
  reserved?: boolean;              // Whether reserved (prevents inversion/disabling/deletion)
}


// Bitmap Mask (New)
export interface BitmapMask {
  id: string;
  src: string;              // Grayscale asset URL
  assetId: string;          // Asset ID (content-addressed, persistent)
  bounds: LocalRect;        // Position and dimensions of mask in layer local space
  inverted: boolean;        // Inversion effect (true: destination-out, false: destination-in)
  enabled: boolean;         // Whether enabled
  feather: number;          // Feather radius (px), applies Gaussian blur during rendering (0 = no feather)
  tag?: string;             // Optional semantic tag (e.g. 'drilled' for drill-merged mask)
}

export interface Snapshot {
  id: string;
  timestamp: number;
  thumbnail?: string;
  data: unknown;
}

export interface HistoryState {
  past: Snapshot[];
  future: Snapshot[];
}

export interface GlobalSnapshot {
  id: string;
  timestamp: number;
  frames: Frame[];
}


export interface CameraState {
  x: number;
  y: number;
  k: number;
}

export interface TextLayerData {
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  /** Text box dimension mode: auto=expand to content, fixed=user-specified fixed dimensions */
  boxMode: 'auto' | 'fixed';
  /** Fixed width specified by user in fixed mode (canvas local px) */
  boxWidth?: number;
  /** Fixed height specified by user in fixed mode (canvas local px) */
  boxHeight?: number;
}

export interface Layer {
  id: string;
  name: string;
  type: 'image' | 'text' | 'vector' | 'color' | 'paint';
  src: string;
  assetId: string;
  role?: LayerRole;
  textData?: TextLayerData;
  metadata?: {
    format?: string;
    size?: number;
    source?: 'local' | 'url';
    originalName?: string;
    fillColor?: string;
    exif?: ExifData;
    [key: string]: unknown;
  };

  // Transformation properties (relative to Frame)
  cx: number;
  cy: number;
  /**
   * @deprecated Layers in pixel editor are resampled and rasterized to physical pixels by default, scale is constantly 1.0.
   * This property is kept as legacy and can be used in the future to support non-destructive layer transformations like "Smart Objects".
   */
  scale: number;
  rotation: number;
  flip: { h: boolean; v: boolean };

  // Physical attributes
  bounding: Dimensions;
  visibleShape?: LocalShape;
  vectorMasks?: VectorMask[];
  bitmapMasks?: BitmapMask[];

  // State attributes
  visible: boolean;
  locked: boolean;
  opacity: number;


  // Filters & Adjustments (optional)
  adjustments?: AdjustmentState;
  interactive?: boolean; // Whether involved in collision detection (Hit-Testing)
  birthCenter?: { cx: number; cy: number }; // Initial birth center (world coordinates)

  // Relationship attributes
  parentId?: string;
  ancestor?: boolean; // Mark whether it is the "ancestor" layer (used as reference for coordinate alignment)
}

export interface Frame {
  id: string;
  name: string;
  seqNum?: string;
  parentId?: string;

  canvas: Dimensions;
  /** Document resolution in dots per inch. Default 72 (screen). */
  dpi: number;
  camera: CameraState;

  layers: NormalizedState<Layer>;
  activeLayerId: string | null;

  // Clipping attributes
  /**
   * Unified per-tool clip selection map — **keyed by producing tool id**
   * (e.g. `'rect'`, `'ellipse'`, `'lasso'`, `'wand'`, future `'polygon-lasso'`,
   * `'ai-matting'`).
   *
   * Each tool owns its own slot so switching tools never clobbers another
   * tool's selection. The canvas only shows the selection belonging to the
   * *currently active* tool (read via `latestClipTool`).
   *
   * Value is either a `LocalShape` (for rect/ellipse tools — participates in
   * the rendering pipeline crop) or a `LocalPolygon` (for lasso/wand tools —
   * consumed by marching-ants preview and `toLayerMask`).
   *
   * Missing key means "no selection produced by that tool yet".
   *
   * See `docs/opengpex/phase2_irregular_unified_clip_spec.md` §3.
   */
  clipBoxes: Record<string, LocalShape | LocalPolygon>;
  /** Re-Canvas dedicated crop box — orthogonal to tool-based selections. */
  canvasCropBox: LocalShape;

  /**
   * Per-frame active clip tool. Persisted with the frame so switching frames
   * restores the tool the user last used on that specific frame.
   * Default: 'rect'. Updated by `setCropTool`.
   */
  latestClipTool: string; // 'rect' | 'ellipse' | 'lasso' | 'wand'

  imageAspect?: number;
  canvasAspect?: number;

  // Other metadata
  rotation: number;
  assetId?: string; // Associated main asset ID
  thumbnail?: {
    src: string;
    assetId?: string;
  } | null;
  history?: HistoryState;
  extra?: Record<string, unknown>;
}

export interface Asset {
  id: string;
  blob: Blob;
  url: string;
  type: string;
  name: string;
  size: number;
  timestamp: number;
}
