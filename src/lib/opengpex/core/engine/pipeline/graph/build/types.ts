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
 * types.ts — Shared build-phase types.
 *
 * `PreparedSource` and `BuildContext` used to live inline in `RenderGraph.ts`.
 * Moved up so the build-phase functions extracted into sibling `build/` modules
 * can share them without importing from the orchestrator itself.
 *
 * @module core/gpu/graph/build/types
 */

import type { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import type { CompositeContext } from '../RenderGraph';

/**
 * The coordinate basis a reported `contentWindow` is expressed in.
 *
 *   • `'asset'`        — source-asset texels (the shared raw asset's own pixel
 *     grid); the compositor recovers logical px through `layer.dprScale`.
 *   • `'content-local'`— already the layer's local LOGICAL px (vector
 *     transients and materialized solids have dpr 1 by construction); the
 *     compositor must NOT divide by anything.
 */
export type ContentWindowBasis = 'asset' | 'content-local';

/** A rect with an explicit reporting basis (see {@link ContentWindowBasis}). */
export type ContentWindow = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly basis: ContentWindowBasis;
};

/**
 * A per-layer source the compositor draws INSTEAD of the resident asset: a filtered
 * raster transient, or (architecture B) a vector source's offscreen transient. The
 * boolean fields tell `drawLayer` which normalisation steps the pixels have already
 * had, so its flag packing does not double-apply them.
 */
export type PreparedSource = {
  texture: LayerTexture;
  suppressAdjust: boolean;
  vectorTransient?: boolean;
  sourceIsLinear: boolean;
  sourceIsWorkingGamut: boolean;
  sourceIntentApplied: boolean;
  /**
   * WHERE THE VISIBLE CONTENT LIVES in `texture`, in the TEXTURE's own texels.
   * This is the single source of truth the effect prepass anchors its stroke
   * ring on — it never re-derives the rect from `layer.crop` semantics, so a
   * stale/unrebased crop on a content-aligned trimmed asset cannot shift the
   * ring (the physical-fragment registration bug). Written by every source-prep
   * stage that knows the fact:
   *   • unfiltered raster — the fragment model's content rect (`crop · dpr`
   *     for a shared-asset fragment, the full texture otherwise);
   *   • filter products — the full output texture (the transient holds exactly
   *     the window, window origin at texel (0,0));
   *   • vector transients — the visible sub-rect of the full-extent transient.
   * Undefined → the full texture (content-aligned).
   */
  contentRectInTexture?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /**
   * WINDOWED-CONVOLUTION content rect: the texture holds ONLY this
   * sub-rect of the source asset, so the compositor's UV map must re-express
   * `layer.crop` relative to it. The `basis` field declares the coordinate
   * space (see {@link ContentWindowBasis}) — consumers switch on it explicitly
   * instead of assuming a `dprScale` division. Undefined → the texture is
   * content-aligned with the full asset (historical behaviour).
   */
  contentWindow?: ContentWindow;
  /**
   * The `contentWindow` extends BEYOND the source asset bounds (alphaFeather's
   * unclamped feather ring — see `resolveFilterWindow`'s `beyondSource`), so the
   * compositor must draw the quad over the WHOLE window (not just `layer.crop`):
   * the feathered ring outside the crop is real content that has to be visible.
   * `resolveLayerGeometry` then derives quad placement + full [0,1] UVs from the
   * window itself. Undefined/false → the historical crop-quad behaviour.
   */
  expandQuadToWindow?: boolean;
  /**
   * True when the prepass ALREADY baked `bmask` and `vmask` into the source's
   * alpha (the G3 effect prepass contract). The compositor must skip both mask
   * bindings and analytic vmask evaluation so the expanded effect quad is not
   * double-masked or clipped at the wrong bounds.
   */
  maskFree?: boolean;
  /**
   * The source is an UNFILTERED DECLARATIVE SOLID — its colour rides the
   * layer uniform's tail vec4 and `texture` is the shared 1×1 white
   * binding formality (the shader discards the sample and reads the
   * uniform). Stamped by `prepareFilteredSources` at the point where
   * "materialized vs uniform" is decided; a FILTERED solid does NOT carry
   * it (its transient holds real pixels). The compositor also requires
   * `sourceIsLinear` alongside it, which the chain already sets.
   */
  solidUniform?: boolean;
};

/**
 * Bundles the build phase's repeatedly-destructured parameter group
 * (`device`/`pipelineCache`/`bufferRing`/`texturePool` + `workingFormat` + `scratch`)
 * into one context object, so `runFilterChain`/`prepareFilteredSources`/
 * `prepareVectorSources` take a single `ctx` instead of three separate params.
 * Extends `CompositeContext` to inherit `resolveLutView`/`resolveLut3dView`/`assets`/
 * `exportViewport` for free, rather than duplicating those fields.
 */
export interface BuildContext extends CompositeContext {
  readonly workingFormat: 'rgba16float' | 'rgba32float';
  readonly scratch: GPUTexture[];
}
