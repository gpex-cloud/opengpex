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
import type { ImageMetadata } from '../files/types';
import type { ColorValue } from '@opengpex/editor/core/engine/color';
// LocalShape is used by VectorMask, canvasClipBox, etc.
// LocalPolygon is used by clipBoxes (unified selection type after selection_layer_unification).

// ─────────────────────────────────────────────────────────────
// Color Management Types
// ─────────────────────────────────────────────────────────────

/**
 * Supported working color spaces — built-in RGB spaces that can be
 * exactly converted via 3×3 linear matrices (no ICC engine required).
 *
 * These are the color spaces the internal pixel pipeline can operate in.
 * For file-level metadata identification (including CMYK, grayscale, unknown),
 * see `ColorSpaceId` in `core/files/types.ts`.
 *
 */
export type WorkingColorSpace = 'srgb' | 'display-p3' | 'adobe-rgb' | 'prophoto-rgb';

/**
 * Transfer Characteristic (TRC) — describes the gamma encoding of pixel values.
 *
 * - `'srgb-trc'`: Standard sRGB transfer curve (IEC 61966-2-1), ~gamma 2.2 with linear segment.
 * - `'linear'`: Linear-light encoding (gamma 1.0). Physically correct for compositing/blending.
 */
export type TRC = 'srgb-trc' | 'linear';

export type RenderEngine = 'canvas' | 'webgpu';
export const LAYER_ROLES = ['host', 'frag', 'exchange'] as const;
export type LayerRole = typeof LAYER_ROLES[number];

/** Layer blend mode — maps directly to CanvasRenderingContext2D.globalCompositeOperation */
export type LayerBlendMode =
  | 'source-over'
  | 'multiply' | 'darken' | 'color-burn'
  | 'screen' | 'lighten' | 'color-dodge'
  | 'overlay' | 'soft-light' | 'hard-light'
  | 'difference' | 'exclusion'
  | 'hue' | 'saturation' | 'color' | 'luminosity';

export interface NormalizedState<T> {
  byId: Record<string, T>;
  order: string[];
}


export interface AdjustmentState {
  brightness: number; // 0-200, default 100
  contrast: number;   // 0-200, default 100
  saturation: number; // 0-200, default 100
  hueRotate: number;  // 0-360, default 0
  blur: number;       // 0-20, default 0
  /**
   * Edge feather σ in px (0-20, default 0) — softens the bitmap ALPHA edge via
   * the non-destructive `alphaFeather` filter without blurring interior detail.
   * Optional (absent = 0) so documents written before the field existed
   * deserialize unchanged.
   */
  edgeFeather?: number;
}

// ─────────────────────────────────────────────────────────────
// Advanced adjustment state
// ─────────────────────────────────────────────────────────────
//
// These are declarative, serializable per-layer states written by
// `AdjustmentDrawer` and consumed by the IFilter runtime. They must
// remain plain-JSON (no functions, no DOM refs) so they can travel
// through `WorkerBridge.postMessage` unchanged.
//
// Applying these adjustments does NOT change `Layer.assetId`, which
// keeps the 16-bit fidelity export channel intact.

/** A single curve is a list of control points [input, output] in 0..1 range. */
export type CurvePoints = Array<[number, number]>;

export interface CurvesState {
  /** Master luminance curve. */
  rgb?: CurvePoints;
  red?: CurvePoints;
  green?: CurvePoints;
  blue?: CurvePoints;
}

export interface LevelsState {
  /** 0–255, default 0. */
  inputBlack: number;
  /** 0–255, default 255. */
  inputWhite: number;
  /** 0.1–10, 1.0 = linear. */
  gamma: number;
  /** 0–255, default 0. */
  outputBlack: number;
  /** 0–255, default 255. */
  outputWhite: number;
}

export interface ChannelMixState {
  /** [fromR, fromG, fromB] → outputR (default [1, 0, 0]). */
  red: [number, number, number];
  /** [fromR, fromG, fromB] → outputG (default [0, 1, 0]). */
  green: [number, number, number];
  /** [fromR, fromG, fromB] → outputB (default [0, 0, 1]). */
  blue: [number, number, number];
  /** Optional constant offset per output channel (default [0, 0, 0]). */
  constant?: [number, number, number];
}

/**
 * Color Balance per-layer state.
 * Each tone range has 3 sliders: [cyan-red, magenta-green, yellow-blue]
 * Range [-100, +100], 0 = no offset (identity).
 *
 * Consumed by IFilter. Does not change `assetId`.
 */
export interface ColorBalanceState {
  /** Shadows region [cyanRed, magentaGreen, yellowBlue] */
  shadows: [number, number, number];
  /** Midtones region [cyanRed, magentaGreen, yellowBlue] */
  midtones: [number, number, number];
  /** Highlights region [cyanRed, magentaGreen, yellowBlue] */
  highlights: [number, number, number];
  /** Preserve luminosity (default: true, matches Photoshop default). */
  preserveLuminosity: boolean;
}

export interface VectorMask {
  id: string;
  shape: LocalShape;          // Shape descriptor (local coordinate system)
  inverted: boolean;               // Whether to invert mask
  feather: number;                 // Feather radius (px)
  enabled: boolean;                // Whether enabled
  reserved?: boolean;              // Whether reserved (prevents inversion/disabling/deletion)

  /** Associated fragment layer id — this hole mask corresponds to a cut fragment layer. */
  assocLayerId?: string;
}


// Bitmap Mask (New)
export interface BitmapMask {
  id: string;
  src: string;              // Grayscale asset URL
  assetId: string;          // Asset ID (content-addressed, persistent)
  bounds: LocalRect;        // Position and dimensions of mask in layer local space
  /**
   * FAMILY discriminator (restore inverted-record architecture): `false` = erase
   * family (contributes alpha to the combine PRODUCT), `true` = restore family
   * (contributes `1 − alpha` to the combine MAX). Both families boot white, so
   * the two initializations are identical — only the combine-side semantics and
   * the write-side op routing differ.
   */
  inverted: boolean;
  enabled: boolean;         // Whether enabled
  feather: number;          // Feather radius (px), applies Gaussian blur during rendering (0 = no feather)
  /**
   * HARD mask — threshold the sampled alpha at 0.5 instead of using it as-is
   * (1-bit binary edge, "pencil eraser"). Omitted / false = soft (sample alpha
   * as-is). Only settable while brush hardness is 100%; the GPU does the
   * binarization at sample time, the baked alpha stays untouched.
   */
  hard?: boolean;
  /**
   * PAINTED marker — the record has received at least one eraser/restore stamp
   * (set on every stroke bake). A restore-family record without it is PRISTINE:
   * the erase op's hole-fill skips it (no pointless epoch bump / upload for a
   * still-all-white record). Erase-family records are written unconditionally,
   * so the flag only gates the restore family's hole-fill targeting.
   */
  painted?: boolean;
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

/**
 * Text box dimension mode. 'auto' is a read-time alias of 'auto_width' — new
 * layers must be created with an explicit modern mode; persisted projects
 * carrying 'auto' keep rendering/measuring as auto-width without migration.
 */
export type TextBoxMode = 'auto' | 'auto_width' | 'auto_height' | 'fixed';

/**
 * Collapse the legacy spellings to the modern canonical value: `undefined`
 * (pre-boxMode layers) and the persisted-project alias 'auto' both read as
 * 'auto_width'. Every consumer that branches on the mode normalizes FIRST, so
 * no downstream code ever needs to know the alias exists.
 */
export function normalizeBoxMode(mode: TextBoxMode | undefined): TextBoxMode {
  return mode === undefined || mode === 'auto' ? 'auto_width' : mode;
}

export interface TextLayerData {
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: ColorValue;  // structured foreground colour (wide-gamut currency)
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  /** Extra spacing inserted after each glyph, in canvas-local px (default 0) */
  letterSpacing?: number;
  /**
   * Vertical alignment of the content block inside a fixed-size text box
   * ('auto_width'/'auto_height' boxes hug the content, so only 'fixed'
   * honors this). Default 'top'.
   */
  verticalAlign?: 'top' | 'middle' | 'bottom';
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  /**
   * Text box dimension mode:
   * - 'auto': legacy alias of 'auto_width' (kept for persisted projects)
   * - 'auto_width': point text — width and height both hug the content, no wrapping
   * - 'auto_height': paragraph text — width locked to boxWidth, wraps, height grows
   * - 'fixed': user-sized box, overflow clipped (no overflow badge)
   */
  boxMode: TextBoxMode;
  /** Fixed width specified by user in fixed mode (canvas local px) */
  boxWidth?: number;
  /** Fixed height specified by user in fixed mode (canvas local px) */
  boxHeight?: number;
}

/**
 * One sample of a logic-brush trajectory.
 * Coordinates are layer-local pixels; the tip radius at this point is
 * `size / 2 × pressure`.
 */
export interface StrokePoint {
  readonly x: number;
  readonly y: number;
  /** 0..1 pen pressure. */
  readonly pressure: number;
}

/**
 * Vector brush point-stream model — stored on `Layer.strokeData` for a
 * `type:'vector'` layer, sibling to `markerData`. The scene-assembly mapper
 * (`vectorSources.ts`) converts `color` to working-gamut linear and packs the
 * points into the GPU-side {@link StrokeParams}; the StrokeRenderer extrudes a ribbon.
 */
export interface StrokeData {
  readonly points: readonly StrokePoint[];
  /** Author-space colour (mapper converts to working-gamut linear). */
  readonly color: ColorValue;
  /** Tip diameter at pressure=1, in px. */
  readonly size: number;
  /** Soft-edge hardness, 0..1. */
  readonly hardness: number;
  /**
   * Edge anti-aliasing toggle. `undefined`/`true` = analytic smoothstep AA
   * (default, zero-regression); `false` = hard edge (binary capsule coverage,
   * pixel-art style). Persisted with the layer's strokeData.
   */
  readonly antiAliased?: boolean;
}

/**
 * UI-only provenance tag for the layers-panel icon — purely a display label for
 * "which tool produced this layer", decoupled from `Layer.type` (the render-engine
 * dispatch key). The render pipeline (Scene / SceneAssembler / RenderGraph /
 * VectorRenderer) must never read this field — it only ever branches on `Layer.type`.
 *
 * A missing tag, or one the icon table doesn't recognise (e.g. a third-party
 * plugin's own tool tag), resolves to the `misc` fallback icon.
 */
export type LayerSourceTool =
  | 'image'    // Plain imported bitmap
  | 'marker'   // Marker tool (rect/ellipse/arrow annotation)
  | 'brush'    // Vector brush stroke
  | 'eraser'   // Legacy eraser bake
  | 'restore'  // Legacy restore bake
  | 'mosaic'   // Mosaic bake
  | 'misc';    // Fallback: tag missing or unrecognised

export interface Layer {
  id: string;
  name: string;
  type: 'image' | 'text' | 'vector' | 'color' | 'paint' | 'group';
  src: string;
  assetId: string;
  role?: LayerRole;
  textData?: TextLayerData;
  /** Vector brush point-stream data — only present when type='vector' and created by the Brush Tool. */
  strokeData?: StrokeData;
  metadata?: {
    fillColor?: ColorValue;
    /** Layers-panel icon provenance tag, display-only. See `LayerSourceTool`. */
    sourceTool?: LayerSourceTool;
    /** This layer was derived from which source layer (both copy and cut set this). */
    sourceLayerId?: string;
    /** The hole mask id on the source layer that corresponds to this cut fragment (only cut fragments have this). */
    assocMaskId?: string;
    /**
     * Marks a `type:'group'` layer as an auto-created container for consecutively
     * drawn Marker Tool vectors. Distinguishes it from user-created manual groups
     * so the Marker Tool only ever appends into its own groups (see MarkerOverlay
     * place command). Absent/false on all other groups.
     */
    isVectorGroup?: boolean;
    /**
     * Marks a `type:'group'` layer as an auto-created container for consecutively
     * placed Text Tool layers. Symmetric to `isVectorGroup` but kept as a separate
     * flag on purpose: the Text Tool must only append into its own text groups and
     * never mix text into a Marker group (and vice versa), so mixed text/marker
     * creation naturally starts a fresh group when the tool switches. See the
     * TextOverlay place command. Absent/false on all other groups.
     */
    isTextGroup?: boolean;
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
  /** Layer blend mode (maps to globalCompositeOperation). Defaults to 'source-over' (Normal) when undefined. */
  blendMode?: LayerBlendMode;
  /** Layer fill opacity (0–1). Controls content opacity without affecting layer styles. Defaults to 1. */
  fill?: number;

  // Filters & Adjustments (optional)
  adjustments?: AdjustmentState;
  /**
   * Declarative RGB / per-channel tone curves written by `AdjustmentDrawer`.
   * Consumed by IFilter. Does not change `assetId`.
   */
  curves?: CurvesState;
  /**
   * Declarative levels adjustment (histogram black/white/gamma remap).
   * Consumed by IFilter. Does not change `assetId`.
   */
  levels?: LevelsState;
  /**
   * Declarative RGB channel-mixer matrix.
   * Consumed by IFilter. Does not change `assetId`.
   */
  channelMix?: ChannelMixState;
  /**
   * Declarative color balance (shadow/midtone/highlight color offsets).
   * Consumed by IFilter (luminance-aware). Does not change `assetId`.
   */
  colorBalance?: ColorBalanceState;
  interactive?: boolean; // Whether involved in collision detection (Hit-Testing)
  /**
   * Clip to the layer below (Photoshop-style clipping mask). Consumed by the v2
   * render pipeline (`Scene.LayerNode.clip` → `blend.wgsl` clip flag). Optional;
   * absent/false means the layer composites normally.
   */
  clip?: boolean;

  birthCenter?: { cx: number; cy: number }; // Initial birth center (world coordinates)

  // Relationship attributes
  hostId?: string;    // Triplet binding: exchange/frag → host layer (internal mechanism)
  groupId?: string;   // Layer group membership: points to a type:'group' layer id (user-facing hierarchy)
  collapsed?: boolean; // Group-only: whether this group is collapsed in the layers panel (default false = expanded)
  ancestor?: boolean; // Mark whether it is the "ancestor" layer (used as reference for coordinate alignment)
}

export interface Frame {
  id: string;
  name: string;
  /** Original source filename (with extension) used to create this frame. */
  source?: string;
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
   * (e.g. `'rect'`, `'pathellipse'`, `'lasso'`, `'wand'`, future `'polygon-lasso'`,
   * `'ai-matting'`).
   *
   * Each tool owns its own slot so switching tools never clobbers another
   * tool's selection. The canvas only shows the selection belonging to the
   * *currently active* tool (read via `latestClipTool`).
   *
   * Value is a `LocalPolygon` for all tool types (rect/pathellipse/lasso/wand).
   * The rect tool writes a 4-point LocalPolygon via `rectToLocalPolygon`; the
   * pathellipse tool writes a 360-point LocalPolygon via
   * `ellipsePathToLocalPolygon`. Consumers call
   * `polygonToShape` to convert back to a LocalShape when needed.
   *
   * Missing key means "no selection produced by that tool yet".
   */
  clipBoxes: Record<string, LocalPolygon>;
  /** Re-Canvas dedicated clip box — orthogonal to tool-based selections. */
  canvasClipBox: LocalShape;

  /**
   * Per-frame active clip tool. Persisted with the frame so switching frames
   * restores the tool the user last used on that specific frame.
   * Default: 'rect'. Updated by `setClipTool`.
   */
  latestClipTool: string; // 'rect' | 'pathellipse' | 'lasso' | 'wand' | 'sam'

  imageAspect?: number;
  canvasAspect?: number;

  // Other metadata
  rotation: number;
  /**
   * Original imported source file's asset ID (SHA-256 hash).
   * Used for revert (re-decode) and fast-export (lossless round-trip).
   *
   * For 8-bit imports: equals baseLayer.assetId (display = source, same file).
   * For 16-bit imports: points to the original high-res file (registered with skipTiling),
   *   which differs from baseLayer.assetId (8-bit display blob).
   * For animated GIF: points to the original .gif file.
   */
  assetId?: string;
  thumbnail?: {
    src: string;
    assetId?: string;
  } | null;
  history?: HistoryState;
  extra?: Record<string, unknown>;

  /** Document-level image metadata (EXIF, ICC, source info). Persists regardless of layer changes. */
  metadata?: ImageMetadata;

  /**
   * Per-document HDR presentation switch (a render filter). `undefined` =
   * auto: follow the file (HDR sources on, SDR sources off). ON presents via
   * the rgba16float + extended surface and the unclamped-tail view variant; OFF is
   * the SDR surface (hard white clamp at the swapchain). NEVER touches pixel
   * data — the composite buffer always holds the unbounded scene-referred
   * truth; the switch only chooses the presentation filter. Also drives the
   * HDR-container export semantics (WYSIWYG: panel display and exported file
   * share one resolver).
   */
  hdrRender?: boolean;

  /**
   * Per-document RAW style preset switch (the "pre-grade" colour step — a
   * render filter, like {@link hdrRender}). `undefined`/ON = the preset applies
   * to scene-linear (RAW) sources at composite time; OFF renders the neutral
   * chromometric baseline (the pre-2026-10 look). NEVER touches pixel data —
   * the f16 master stays the K-anchored linear truth; the switch only chooses
   * the intent nibble (2 = Filmic + style vs 1 = Filmic). Present/meaningful
   * only on RAW documents; non-RAW sources ignore it structurally (no white
   * domain → SDR passthrough → the style is unreachable).
   */
  rawStyle?: boolean;

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
