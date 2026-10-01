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
 * Scene.ts — The declarative frame descriptor.
 *
 * ARCHITECTURAL ROLE:
 * `Scene` replaces v1's imperative renderer lifecycle
 * (`beginFrame → pushCommand* → flush → endFrame` + the `drawLayerDirect`
 * back-door). The UI/state layer emits an immutable, pure-data `Scene`; the
 * engine compiles it into a RenderGraph. No implicit state machine, no
 * interaction flags leaking into the render contract.
 *
 * HARD INVARIANTS:
 *   1. Everything here is PURE DATA — serializable, no class instances, no DOM
 *      handles, no callbacks. This is what makes replay / caching / dirty-region
 *      diffing possible.
 *   2. All members are `readonly`. A Scene is never mutated; a new frame means
 *      a new Scene object (structural sharing is fine and encouraged).
 *   3. `layers` is FLAT and ordered bottom-to-top. Layer groups are flattened
 *      by the SceneAssembler — group-as-composite-unit is v3 scope.
 *
 * ⚠️ NAMING: this file's `LayerNode` is a FLAT RENDER ITEM (an element of
 * `Scene.layers`). The v3 roadmap's `LayerNode` is a TREE AST node. Same name,
 * different things.
 *
 * @module core/gpu/scene/Scene
 */

import type { Rect, WorkingColorSpace, LayerBlendMode, GamutId, RenderIntent } from '@opengpex/editor/core/types';

// ────────────────────────────────────────────────────────────
// Geometry
// ────────────────────────────────────────────────────────────

/**
 * 2D affine transform (local → world), stored as the 6 meaningful components
 * of a 3×3 matrix whose last row is implicitly [0, 0, 1]:
 *
 *   | a  c  tx |
 *   | b  d  ty |
 *   | 0  0  1  |
 *
 * Component order/naming matches v1's `MatrixData` and the DOMMatrix
 * convention, so `SceneAssembler` can pass existing layer matrices through
 * unchanged. The engine expands this to a padded `mat3x3<f32>` uniform.
 */
export interface Mat3 {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly tx: number;
  readonly ty: number;
}

/** Identity transform — a no-op local → world mapping. */
export const MAT3_IDENTITY: Mat3 = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

// ────────────────────────────────────────────────────────────
// View (camera / viewport transform) — Compose-Once, View-Many
// ────────────────────────────────────────────────────────────

/**
 * The VIEW transform — how the composited DOCUMENT is mapped onto the swapchain
 * ("Compose-Once, View-Many").
 *
 * ARCHITECTURAL ROLE (compose / view separation):
 *   • Document compositing (`Scene.frame` + `LayerNode.transform`) is CAMERA-
 *     INDEPENDENT: layers composite into a document-sized target once, and the
 *     result is cached until layer content/attributes/order change.
 *   • The VIEW transform is CAMERA-DEPENDENT and cheap: it blits that cached
 *     composited texture onto the swapchain applying camera pan/zoom + DPR.
 *     Pan/zoom only replays this view pass — no re-compositing.
 *
 * `transform` maps document/canvas-space coordinates (0..frame.width,
 * 0..frame.height in document units) → swapchain physical pixels. It is exactly
 * the `M_camera` that was previously baked into every layer's `transform` and
 * is now the SOLE camera source.
 *
 * COMPOSE/VIEW CONTRACT:
 *   • `Scene.frame` is the DOCUMENT (canvas native) size; `LayerNode.transform`
 *     is camera-INDEPENDENT (local → canvas space). The RenderGraph composites
 *     into a document-sized texture.
 *   • `view.transform` (this) + `view.target` present that document texture onto
 *     the swapchain. Pan/zoom only replay the view pass — no re-compositing.
 */
export interface ViewConfig {
  /** Document/canvas-space → swapchain physical-pixel affine (the camera). */
  readonly transform: Mat3;
  /** Swapchain target size in physical pixels (viewport × DPR). */
  readonly target: { readonly width: number; readonly height: number };
}

// ────────────────────────────────────────────────────────────
// Layer sources
// ────────────────────────────────────────────────────────────

/**
 * How a layer produces its pixels.
 *
 * Classified by RASTERIZATION METHOD, not by product-level tool type. Text /
 * marker / vector layers are all `raster`: the SceneAssembler pre-rasterizes
 * their declarative data (`textData` / `markerData` / path data) on the Worker
 * CPU into an `ImageBitmap`, then `upload()`s it as a resident texture. This
 * keeps the union from growing one arm per annotation tool.
 */
/**
 * The engine-owned geometry primitive an {@link SdfShapeParams} describes. A
 * RENDER-CORE enum, deliberately DISTINCT from any business discriminant (e.g. the
 * marker plugin's `MarkerKind`): the scene-assembly layer translates business kinds
 * into these primitive names (`markerToVectorSource`), so nothing under `gpu/` /
 * `pipeline/graph/` / `shaders/` ever imports a business model.
 */
export type SdfPrimitive = 'rounded_rect' | 'ellipse' | 'arrow';

/**
 * Analytic SDF description of a vector primitive — PURE GPU maths, no business
 * model. Produced by the scene-assembly layer (`markerToVectorSource`) and consumed
 * by `SdfRenderer` as a compact uniform. Colours are already in the document WORKING
 * gamut (Display-P3) LINEAR light, so the offscreen render feeds the compositor as an
 * already-linear / already-working-gamut source.
 */
export interface SdfShapeParams {
  /** The geometry primitive to solve (engine-owned; see {@link SdfPrimitive}). */
  readonly prim: SdfPrimitive;
  /** Shape-local base size [width, height] in LOGICAL pixels. */
  readonly size: readonly [number, number];
  /** Stroke width in LOGICAL pixels. */
  readonly strokeWidth: number;
  /** Stroke colour: working-gamut LINEAR RGBA (0..1). */
  readonly strokeColor: readonly [number, number, number, number];
  /** Whether fill is drawn (`fill.opacity > 0`). */
  readonly hasFill: boolean;
  /** Fill colour: working-gamut LINEAR RGB + alpha already ×fill.opacity (0..1). */
  readonly fillColor: readonly [number, number, number, number];
  /** Arrowhead size multiplier (ignored by rounded_rect/ellipse). */
  readonly headScale: number;
  /**
   * Shape-specific geometry (LOCAL pixel space):
   * - rounded_rect: [cornerRadius, 0, 0, 0]
   * - ellipse:      [0, 0, 0, 0] (geometry implied by `size`)
   * - arrow:        [tail.x, tail.y, head.x, head.y] (arbitrary direction)
   */
  readonly shapeParams: readonly [number, number, number, number];
}

/** The built-in vector rendering strategies (static union — no runtime registry). */
export type VectorRendererId = 'sdf' | 'stroke';

/**
 * GPU-side params for the `stroke` renderer (logic brush ribbon extrusion).
 * An engine-neutral trajectory: the packed point stream + brush attributes the
 * StrokeRenderer's compute pass extrudes into a ribbon mesh. Carries NO business
 * model (that lives on `Layer.strokeData`); the scene-assembly mapper resolves colour
 * to working-gamut linear and packs the geometry before it reaches here.
 */
export interface StrokeParams {
  /** Packed trajectory: [x, y, pressure, _pad] × N (working/logical pixel geometry). */
  readonly points: Float32Array;
  /** Number of points in `points` (points.length === pointCount × 4). */
  readonly pointCount: number;
  /** Brush colour: working-gamut LINEAR straight-alpha RGBA (0..1). */
  readonly color: readonly [number, number, number, number];
  /** Tip diameter at pressure=1, in px. */
  readonly size: number;
  /** Soft-edge hardness, 0..1. */
  readonly hardness: number;
  /**
   * Bounding width in LOGICAL pixels — the same value `prepareVectorSources` sizes
   * the transient from (`layer.width`). The StrokeRenderer's vertex shader maps the
   * logical-pixel trajectory into NDC by dividing by this, exactly as `SdfShapeParams.size`
   * feeds `SdfRenderer`'s vs; the renderer has no other channel to the bounding extent.
   */
  readonly width: number;
  /** Bounding height in LOGICAL pixels (see {@link StrokeParams.width}). */
  readonly height: number;
}

/**
 * Which built-in vector renderer draws a `vector` source, plus its params. A STATIC
 * union (not a runtime registry): both strategies are engine built-ins, so the
 * discriminant `renderer` is all the render core needs to dispatch.
 */
export type VectorParams =
  | { readonly renderer: 'sdf'; readonly sdf: SdfShapeParams }
  | { readonly renderer: 'stroke'; readonly stroke: StrokeParams };

export type LayerSource =
  /** A resident GPUTexture, keyed by asset id (bitmap / pre-rasterized text / vector). */
  | {
    readonly kind: 'raster';
    readonly assetId: string;
    /**
     * The asset's TRANSFER CHARACTERISTIC.
     *
     * Compositing happens in LINEAR LIGHT, so the shaders decode sRGB→linear on
     * sample unless this says the pixels are already linear. Omitted ⇒
     * `'srgb-trc'`, which is correct for every 8-bit `bitmap` asset (browser
     * decoders always produce sRGB-encoded pixels) and for the overwhelming
     * majority of 16-bit TIFF/PNG sources.
     *
     * ⚠️ PER-ASSET BY CONTRACT — do NOT derive this from `frame.trc`. That
     * document-level field defaults to `'linear'` for any bitDepth>=16 document
     * (`LayerFactory.getNewFrame`, a v1 VipsBackend-era convention unrelated to the
     * real pixel encoding) while the importer hard-codes `'srgb-trc'`; trusting it
     * would skip the decode for ordinary sRGB 16-bit TIFFs and visibly wash the
     * image out. Precision AND domain are per-layer properties.
     */
    readonly trc?: 'srgb-trc' | 'linear';
    /**
     * The asset's SOURCE PHYSICAL COLOR GAMUT. Omitted ⇒ `'srgb'`.
     *
     * Tags the source gamut; consumed by GPU per-asset gamut→working matrix
     * conversion (via the Uniforms flags field).
     */
    readonly gamut?: GamutId;
    /**
     * The asset's OUT-OF-BOX RENDERING INTENT.
     * Omitted ⇒ `'sdr'` (Display-Referred passthrough) — the default for every
     * bitmap/text/vector, so a camera-baked JPEG is NEVER tone-mapped. RAW ingest
     * tags this explicitly (`'filmic'` / `'dng-lut'`) and carries it FORWARD; the
     * shader must never re-sniff it at render time.
     *
     * Consumed by `resolveSourceRenderIntent` → the `render_intent` flags nibble → `sourceNormalize.ts`.
     */
    readonly renderIntent?: RenderIntent;
  }
  /**
   * A PROCEDURAL vector primitive rendered on the GPU by a {@link VectorParams}
   * strategy — analytic SDF fragment solve today (`renderer: 'sdf'`), with a
   * mesh-extrusion stroke renderer as a declared empty slot (`renderer: 'stroke'`).
   * Carries NO texture — the shape is derived from its params at draw time
   * (zero upload, zero CPU rasterization), so it must NOT be conflated with a raster.
   */
  | ({ readonly kind: 'vector' } & VectorParams);

// ────────────────────────────────────────────────────────────
// Masks
// ────────────────────────────────────────────────────────────

/**
 * Layer mask descriptors (split contract).
 *
 * NOTE the v2 posture: masks are applied as exact per-fragment alpha in the
 * shader. v1's geometric mask shrink fudge — which existed purely to
 * paper over `ctx.clip()`'s 0.75px seam — is DELETED, not ported.
 *
 * The old single `MaskDesc` union (bitmap | vector-rings) is split into two
 * orthogonal channels carried side-by-side on a `LayerNode`:
 * `bmask` (freehand raster alpha — eraser/restore) and `vmask`
 * (analytic geometry selection — ellipse/lasso/wand/fragment hole). They are
 * multiplied together in-shader (`color.a *= bmask.a * vmask.a`), never merged
 * into one representation.
 */

/** Bitmap mask: an alpha texture sampled 1:1 over the layer quad (eraser). */
export interface BitmapMaskDesc {
  readonly maskId: string;
  readonly inverted: boolean;
  readonly hard?: boolean;
}

/**
 * Vector mask: declarative geometry resolved on the GPU. Two sub-paths:
 * - `analytic`: a single rect/ellipse evaluated per-fragment via SDF — no
 *   texture, the shape rides in the layer uniform (`vmask_rect`/`vmask_flags`).
 * - `polygon`: one or more arbitrary sub-masks (lasso/wand/multi-overlay,
 *   even-odd, possibly self-intersecting) baked once by a GPU compute fill-pass
 *   into a resident `rgba8unorm` texture. ≥2 sub-masks are INTERSECTED (v1
 *   `ctx.clip()` intersection semantics): the fill-pass computes each sub-mask's
 *   coverage (its OWN feather + invert baked) and multiplies them. The baked
 *   texture is NOT part of the descriptor — it is a build-local product keyed by
 *   `getVmaskKey(subMasks…)` (position-free, so moving the layer never
 *   re-bakes).
 */
export type VectorMaskDesc =
  | {
    readonly kind: 'analytic';
    readonly shape: 'rect' | 'ellipse';
    /**
     * NORMALIZED FRACTION of the layer's content size:
     * `[cx/w, cy/h, halfW/w, halfH/h]` (each in [0,1]). Resolution-independent —
     * `vmaskUniform` multiplies back to layer-local px at bind time. featherPx
     * stays in absolute px.
     */
    readonly rect: readonly [number, number, number, number];
    readonly featherPx: number;
    readonly inverted: boolean;
    readonly hard?: boolean;
  }
  | {
    readonly kind: 'polygon';
    /**
     * The intersected sub-masks (≥1). Each keeps its OWN feather + invert
     * because those must bake per-mask before the coverage product — they
     * cannot be flattened into one ring set. A single sub-mask is the plain
     * one-polygon case.
     */
    readonly subMasks: readonly VectorSubMask[];
  };

/**
 * One intersected sub-mask of a `polygon` {@link VectorMaskDesc}. Rings are in
 * layer-local pixel space (world→layer-local already applied), even-odd wound,
 * self-intersection allowed. `featherPx`/`inverted` are baked per sub-mask by
 * the fill-pass before the coverage product.
 */
export interface VectorSubMask {
  /** Arbitrary rings for this sub-mask, layer-local pixel space. */
  readonly rings: readonly (readonly (readonly [number, number])[])[];
  readonly featherPx: number;
  readonly inverted: boolean;
}

// ────────────────────────────────────────────────────────────
// Adjustments & filters
// ────────────────────────────────────────────────────────────

/**
 * A colour adjustment, evaluated in-shader by `adjust.wgsl`.
 *
 * SINGLE-TRACK CONTRACT: unlike v1 — which split every adjustment into
 * Track A (`FilterFastTrack`, downsampled CPU preview) and Track B
 * (`FilterCache` Worker RPC) because the CPU could not keep up — v2 has ONE
 * path. Curve/level tables are uploaded as 1D LUT textures; matrices and
 * scalars ride in a uniform buffer. 4K adjustment costs <0.2ms.
 */
export type AdjustmentDesc =
  /** Basic scalars (brightness/contrast/saturation/hue) — a fused colour matrix. */
  | {
    readonly kind: 'basic';
    readonly brightness: number;
    readonly contrast: number;
    readonly saturation: number;
    readonly hueRotate: number;
  }
  /** Per-channel tone curves — uploaded as a 1D LUT texture. */
  | { readonly kind: 'curves'; readonly lutId: string }
  /** Levels (input/output black-white + gamma) — uploaded as a 1D LUT texture. */
  | { readonly kind: 'levels'; readonly lutId: string }
  /** Channel mixer — a 3×3 matrix plus per-channel constant offset. */
  | {
    readonly kind: 'channelMix';
    readonly matrix: readonly number[];
    readonly constant: readonly [number, number, number];
  }
  /** Colour balance — per-tonal-range (shadow/midtone/highlight) RGB shifts. */
  | {
    readonly kind: 'colorBalance';
    readonly shadows: readonly [number, number, number];
    readonly midtones: readonly [number, number, number];
    readonly highlights: readonly [number, number, number];
    readonly preserveLuminosity: boolean;
  }
  /** 3D colour LUT (e.g. a .cube film emulation) sampled as a 3D texture. */
  | { readonly kind: 'lut3d'; readonly lutId: string; readonly strength: number };

/**
 * A neighbourhood filter, executed by `FilterPass` compute shaders.
 * Replaces v1's `shared/filter2d.ts` per-pixel TypedArray loops.
 */
export type FilterDesc =
  /** Separable Gaussian blur (`gaussian.wgsl`, two passes). */
  | { readonly kind: 'gaussianBlur'; readonly radius: number }
  /** Generic convolution kernel (`convolve.wgsl`, tiled). */
  | {
    readonly kind: 'convolve';
    readonly kernel: readonly number[];
    readonly kernelSize: number;
    readonly divisor: number;
    readonly bias: number;
  }
  /** Pixelate / mosaic. */
  | { readonly kind: 'pixelate'; readonly blockSize: number };

// ────────────────────────────────────────────────────────────
// Layer node
// ────────────────────────────────────────────────────────────

/**
 * One flat render item. Pure data; the engine derives all GPU state from it.
 */
export interface LayerNode {
  readonly id: string;
  /** How this layer's pixels come into being. */
  readonly source: LayerSource;
  /** Local → world affine transform. */
  readonly transform: Mat3;
  /** Explicit layer display width (defaults to texture width if not specified). */
  readonly width?: number;
  /** Explicit layer display height (defaults to texture height if not specified). */
  readonly height?: number;
  /** Optional texture sub-region crop (for fragment layers with visibleShape). */
  readonly crop?: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
  /**
   * Physical-to-logical pixel ratio of the resident texture.
   *
   * `crop` / `width` / `height` are expressed in LOGICAL (document) pixels, but a
   * DPR-aware rasterized texture (e.g. a committed Text layer produced by
   * `pixels.rasterize.layer`) is `bounding × dpr` PHYSICAL pixels. This factor —
   * sourced from the asset's `AssetEntry.dprScale` — lets `resolveLayerGeometry`
   * map the logical crop into the physical texture's UV space
   * (`uv = crop × dprScale / texSize`). Defaults to 1 (bitmap / fragment layers
   * whose crop is already in source pixels), keeping their UV identical.
   */
  readonly dprScale?: number;
  /** [0, 1]. */
  readonly opacity: number;
  /** Selects the branch in `blend.ts` `apply_blend`. */
  readonly blendMode: LayerBlendMode;
  /** Freehand raster alpha mask (eraser/restore). Sampled 1:1 over the quad. */
  readonly bmask?: BitmapMaskDesc;
  /** Analytic/polygon geometry selection mask, resolved on the GPU. */
  readonly vmask?: VectorMaskDesc;
  /** Applied in order, before `filters`. */
  readonly adjustments?: readonly AdjustmentDesc[];
  /** Applied in order, after `adjustments`. */
  readonly filters?: readonly FilterDesc[];
  /** Clip to the layer below (Photoshop-style clipping mask). */
  readonly clip?: boolean;
}

// ────────────────────────────────────────────────────────────
// Display config
// ────────────────────────────────────────────────────────────

/**
 * Channel isolation for inspection — a 4-bit visibility mask
 * (bit0 = R, bit1 = G, bit2 = B, bit3 = A).
 *
 * v1 injected `<filter>` elements into the DOM to achieve this. v2 packs this
 * mask into a uniform and runs ONE Photoshop-style rule in the view-pass shader:
 *   • alpha bit set        → grayscale alpha (coverage, not TRC-encoded)
 *   • exactly one RGB bit   → grayscale of that channel (TRC-encoded)
 *   • exactly two RGB bits  → colour with the disabled channel zeroed
 *   • all three (or all-off safety) → normal RGB present (identity)
 *
 * So single-channel, alpha, and any two-channel colour view all fall out of the
 * same rule — no per-combination enum, no "missing case" (the class of bug that
 * the old `'rgb'|'r'|'g'|'b'|'a'` string enum produced when the UI emitted a
 * value it did not list). Isolation is a VIEW concern — see {@link DisplayConfig}
 * and `compositeSignature` (compositing stays channel-agnostic).
 */
export type SceneChannelMask = number;

/** Channel-mask bit for the Red channel. */
export const CHANNEL_MASK_R = 1 << 0;
/** Channel-mask bit for the Green channel. */
export const CHANNEL_MASK_G = 1 << 1;
/** Channel-mask bit for the Blue channel. */
export const CHANNEL_MASK_B = 1 << 2;
/** Channel-mask bit for the Alpha channel. */
export const CHANNEL_MASK_A = 1 << 3;
/** Default mask: full colour (R+G+B, alpha off) — the identity present. */
export const CHANNEL_MASK_RGB = CHANNEL_MASK_R | CHANNEL_MASK_G | CHANNEL_MASK_B;

/**
 * Signal key for the active display channel mask, stored in
 * `state.interaction.signals[DISPLAY_CHANNEL_SIGNAL_KEY]`.
 *
 * Lives here (core) rather than in a plugin because BOTH sides sit outside the
 * plugin: the LayersDrawer Channels panel WRITES it, and `CanvasStage` READS it
 * to fill `scene.display.channelMask`. Runtime-only — it lives in
 * `interaction.signals`, never the persisted document (see `state/reducer.ts`
 * `SET_INTERACTION`), so it has no save-format coupling.
 */
export const DISPLAY_CHANNEL_SIGNAL_KEY = 'engine.display_transform.channel_mask';

/** Final-sink presentation config. */
export interface DisplayConfig {
  readonly channelMask: SceneChannelMask;
  /** Working colour space; drives the swapchain's `colorSpace`. */
  readonly colorSpace: WorkingColorSpace;
  /** When true the swapchain requests `toneMapping: { mode: 'extended' }`. */
  readonly hdr: boolean;
}

// ────────────────────────────────────────────────────────────
// Scene
// ────────────────────────────────────────────────────────────

/**
 * An immutable description of ONE frame.
 *
 * The SAME Scene drives both sinks — `render()` (swapchain) and `export()`
 * (readback) share one compiled RenderGraph, which is what structurally
 * guarantees "preview === export".
 */
export interface Scene {
  /** Target surface size in physical pixels. */
  readonly frame: { readonly width: number; readonly height: number };
  /** Artboard clip bounds in world pixels. Omit for unclipped. */
  readonly artboard?: Rect;
  readonly display: DisplayConfig;
  /**
   * View (camera) transform — maps the composited document onto the swapchain.
   * Carries `M_camera` + swapchain size, serving as the sole camera source.
   */
  readonly view: ViewConfig;
  /** Bottom-to-top order. Flat: groups are already flattened. */
  readonly layers: readonly LayerNode[];
}

/**
 * The CAMERA-INDEPENDENT half of a Scene — everything that determines the
 * COMPOSITED document texture.
 *
 * WHY THIS EXISTS (compose-once/view-many, extended to CPU assembly):
 * Compose-once/view-many made the GPU skip re-compositing on pan/zoom, but `SceneAssembler`
 * still re-assembled the ENTIRE Scene (the O(layers) content half) every camera
 * frame. This type is the assembly-level mirror of the
 * data split the engine already relies on: the content half here is
 * camera/viewport/DPR-INDEPENDENT and can be memoized across cam-only frames,
 * while {@link ViewConfig} + `channelMask` are rebuilt cheaply per frame.
 *
 * INVARIANT (mirrors compositeSignature's inclusion set): every field here is an
 * input to `computeCompositeSignature`; NOTHING camera/present-related lives
 * here. So "same content object reference ⟹ same composite signature", which is
 * what makes reference-identity a SOUND (never false-clean) reuse key.
 */
export interface SceneContent {
  /** Document (canvas native) composite size — camera-independent. */
  readonly frame: { readonly width: number; readonly height: number };
  /** Artboard clip bounds in document space. */
  readonly artboard?: Rect;
  /**
   * The WORKING gamut — always `'display-p3'` as assembled. It is an
   * INVARIANT, not a document property: `GpuDevice.configureSurface` hardcodes the
   * swapchain to display-p3, and per-asset colour truth lives on each
   * `LayerNode.source.gamut`. Do NOT re-derive it from the document.
   */
  readonly colorSpace: WorkingColorSpace;
  readonly hdr: boolean;
  /** Bottom-to-top, flat. The composited layer set. */
  readonly layers: readonly LayerNode[];
}

/** An empty scene — a valid, renderable no-op. Useful for init and teardown. */
export const EMPTY_SCENE: Scene = {
  frame: { width: 0, height: 0 },
  display: { channelMask: CHANNEL_MASK_RGB, colorSpace: 'srgb', hdr: false },
  view: { transform: MAT3_IDENTITY, target: { width: 0, height: 0 } },
  layers: [],
};


