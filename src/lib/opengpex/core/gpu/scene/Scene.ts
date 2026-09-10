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
 * Scene.ts — The declarative frame descriptor (v2 spec §5.1).
 *
 * ARCHITECTURAL ROLE:
 * `Scene` replaces v1's imperative renderer lifecycle
 * (`beginFrame → pushCommand* → flush → endFrame` + the `drawLayerDirect`
 * back-door). The UI/state layer emits an immutable, pure-data `Scene`; the
 * engine compiles it into a RenderGraph. No implicit state machine, no
 * interaction flags leaking into the render contract (§2.1).
 *
 * HARD INVARIANTS:
 *   1. Everything here is PURE DATA — serializable, no class instances, no DOM
 *      handles, no callbacks. This is what makes replay / caching / dirty-region
 *      diffing possible (§5.3).
 *   2. All members are `readonly`. A Scene is never mutated; a new frame means
 *      a new Scene object (structural sharing is fine and encouraged).
 *   3. `layers` is FLAT and ordered bottom-to-top. Layer groups are flattened
 *      by the SceneAssembler (§5.1.2) — group-as-composite-unit is v3 scope.
 *
 * ⚠️ NAMING: this file's `LayerNode` is a FLAT RENDER ITEM (an element of
 * `Scene.layers`). The v3 roadmap's `LayerNode` is a TREE AST node. Same name,
 * different things — see §5.1.2.
 *
 * @module core/gpu/scene/Scene
 */

import type { Rect, WorkingColorSpace, LayerBlendMode } from '@opengpex/editor/core/types';

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
// View (camera / viewport transform) — 缺陷 5 根治 §5, 阶段 0
// ────────────────────────────────────────────────────────────

/**
 * The VIEW transform — how the composited DOCUMENT is mapped onto the swapchain
 * (缺陷 5 §5 "Compose-Once, View-Many").
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
 * the `M_camera` that was previously baked into every layer's `transform` (the
 * source of 缺陷 5) and is now the SOLE camera source (阶段 1b).
 *
 * COMPOSE/VIEW CONTRACT (阶段 1b, live):
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
 * How a layer produces its pixels (§5.1.1).
 *
 * Classified by RASTERIZATION METHOD, not by product-level tool type. Text /
 * marker / vector layers are all `raster`: the SceneAssembler pre-rasterizes
 * their declarative data (`textData` / `markerData` / path data) on the Worker
 * CPU into an `ImageBitmap`, then `upload()`s it as a resident texture. This
 * keeps the union from growing one arm per annotation tool.
 */
export type LayerSource =
  /** A resident GPUTexture, keyed by asset id (bitmap / pre-rasterized text / marker / vector). */
  | { readonly kind: 'raster'; readonly assetId: string }
  /** A logical brush trajectory — StrokePass extrudes the mesh on GPU (§10.2); never baked to a bitmap. */
  | { readonly kind: 'stroke'; readonly strokeId: string };

// ────────────────────────────────────────────────────────────
// Masks
// ────────────────────────────────────────────────────────────

/**
 * Layer mask descriptor.
 *
 * NOTE the v2 posture: masks are applied as exact per-fragment alpha in the
 * shader. v1's geometric mask shrink fudge — which existed purely to
 * paper over `ctx.clip()`'s 0.75px seam — is DELETED, not ported (§2.5 / §15).
 */
export type MaskDesc =
  /** Bitmap mask: an alpha texture sampled 1:1 over the layer quad. */
  | {
      readonly kind: 'bitmap';
      readonly maskId: string;
      readonly inverted: boolean;
      readonly hard?: boolean;
    }
  /** Vector mask: polygon rings in world space, optionally feathered. */
  | {
      readonly kind: 'vector';
      readonly rings: readonly (readonly (readonly [number, number])[])[];
      readonly inverted: boolean;
      readonly feather: number;
      readonly hard?: boolean;
    };

// ────────────────────────────────────────────────────────────
// Adjustments & filters
// ────────────────────────────────────────────────────────────

/**
 * A colour adjustment, evaluated in-shader by `adjust.wgsl` (§9.3).
 *
 * SINGLE-TRACK CONTRACT: unlike v1 — which split every adjustment into
 * Track A (`FilterFastTrack`, downsampled CPU preview) and Track B
 * (`FilterCache` Worker RPC) because the CPU could not keep up — v2 has ONE
 * path. Curve/level tables are uploaded as 1D LUT textures; matrices and
 * scalars ride in a uniform buffer. 4K adjustment costs <0.2ms (§2.2).
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
 * A neighbourhood filter, executed by `FilterPass` compute shaders (§10.1).
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
  /** How this layer's pixels come into being (§5.1.1). */
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
   * Physical-to-logical pixel ratio of the resident texture (§fix/20260911).
   *
   * `crop` / `width` / `height` are expressed in LOGICAL (document) pixels, but a
   * DPR-aware rasterized texture (e.g. a committed Text layer produced by
   * `pixels.rasterize.layer`) is `bounding × dpr` PHYSICAL pixels. This factor —
   * sourced from the asset's `tileMeta.dprScale` — lets `resolveLayerGeometry`
   * map the logical crop into the physical texture's UV space
   * (`uv = crop × dprScale / texSize`). Defaults to 1 (bitmap / fragment layers
   * whose crop is already in source pixels), keeping their UV identical.
   */
  readonly dprScale?: number;
  /** [0, 1]. */
  readonly opacity: number;
  /** Selects the branch in `blend.ts` `apply_blend` (§8.3). */
  readonly blendMode: LayerBlendMode;
  readonly mask?: MaskDesc;
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
 * Channel isolation for inspection.
 *
 * v1 injected `<filter>` elements into the DOM to
 * achieve this. v2 does it with a one-line fragment swizzle (§15).
 */
export type SceneChannelMask = 'rgb' | 'r' | 'g' | 'b' | 'a';

/** Final-sink presentation config. */
export interface DisplayConfig {
  readonly channelMask: SceneChannelMask;
  /** Working colour space; drives the swapchain's `colorSpace` (§4.3). */
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
 * guarantees "preview === export" (§1.2, §3.2).
 */
export interface Scene {
  /** Target surface size in physical pixels. */
  readonly frame: { readonly width: number; readonly height: number };
  /** Artboard clip bounds in world pixels. Omit for unclipped. */
  readonly artboard?: Rect;
  readonly display: DisplayConfig;
  /**
   * View (camera) transform — maps the composited document onto the swapchain
   * (缺陷 5 §5). ADDITIVE in 阶段 0: carries `M_camera` + swapchain size, but
   * layers are still fully-baked, so it is not yet the sole camera source.
   */
  readonly view: ViewConfig;
  /** Bottom-to-top order. Flat: groups are already flattened (§5.1.2). */
  readonly layers: readonly LayerNode[];
}

/**
 * The CAMERA-INDEPENDENT half of a Scene — everything that determines the
 * COMPOSITED document texture (P1 §4 / 缺陷 5 阶段 3).
 *
 * WHY THIS EXISTS (compose-once/view-many, extended to CPU assembly):
 * 缺陷 5 阶段 2 made the GPU skip re-compositing on pan/zoom, but `SceneAssembler`
 * still re-assembled the ENTIRE Scene (the O(layers) content half) every camera
 * frame — the residual P1 cost. This type is the assembly-level mirror of the
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
  /** Working colour space + hdr sink hints (channelMask is a VIEW concern). */
  readonly colorSpace: WorkingColorSpace;
  readonly hdr: boolean;
  /** Bottom-to-top, flat. The composited layer set. */
  readonly layers: readonly LayerNode[];
}

/** An empty scene — a valid, renderable no-op. Useful for init and teardown. */
export const EMPTY_SCENE: Scene = {
  frame: { width: 0, height: 0 },
  display: { channelMask: 'rgb', colorSpace: 'srgb', hdr: false },
  view: { transform: MAT3_IDENTITY, target: { width: 0, height: 0 } },
  layers: [],
};


