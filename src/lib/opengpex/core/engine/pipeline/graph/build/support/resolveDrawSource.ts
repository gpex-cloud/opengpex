/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the GNU General Public License.
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
 * resolveDrawSource.ts — the single seam between the build-phase `sources`
 * chain map and the composite draw passes.
 *
 * Two shapes of duplication it collapses:
 *
 *   1. RENDERGRAPH CALL SITES — every composite loop (pure-separable fast
 *      path, ping-pong separable branch, non-separable branch) unpacked the
 *      same `PreparedSource` into the same 15-field params object, with the
 *      same `maskFree` guard on the bmask/vmask lookups. One new
 *      `PreparedSource` field meant three parallel edits; a missed one passed
 *      `undefined` SILENTLY. `resolveDrawSourceParams` owns that unpack once.
 *
 *   2. DRAW-PASS GEOMETRY — `CompositePass` and `BlendPass` each computed the
 *      identical `resolveLayerGeometry` → POT-bucket `physicalUvRect` scale →
 *      `resolveVmaskUniform` triple. Adding a `PreparedSource` field that
 *      feeds geometry (as `contentWindow` did) meant synchronized edits in
 *      two render passes that MUST agree bit-for-bit or the separable and
 *      non-separable paths diverge. `resolveLayerDrawGeometry` owns it once.
 *
 * Pure data plumbing — zero GPU state, zero behaviour change by construction
 * (the refactored call sites keep their existing param fields verbatim).
 *
 * @module core/gpu/graph/build/support/resolveDrawSource
 */

import type { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import type { LayerNode } from '../../../scene/Scene';
import { resolveLayerGeometry, resolveLayerDprScale } from '../../support/layerGeometry';
import { resolveVmaskUniform, type VmaskUniformFields } from '../../support/vmaskUniform';
import type { PreparedSource, ContentWindow } from '../types';

/** The vmask-bake record the vmask prepare stage emits per layer. */
interface VmaskBakeLike {
  readonly texture: LayerTexture;
  readonly window?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

/** Minimal shape of the bmask/vmask maps RenderGraph threads through. */
export interface DrawSourceMaps {
  readonly bmaskSources: ReadonlyMap<string, LayerTexture>;
  readonly vmaskSources: ReadonlyMap<string, VmaskBakeLike>;
}

/** The `PreparedSource`-derived subset shared by every composite draw call. */
export interface DrawSourceParams<
  TAdjustCoverage,
  TTexture extends LayerTexture = LayerTexture,
> {
  readonly texture: TTexture;
  readonly maskTexture: LayerTexture | undefined;
  readonly vmaskTexture: LayerTexture | undefined;
  readonly vmaskWindow: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | undefined;
  readonly adjustCoverage: TAdjustCoverage | undefined;
  readonly solidUniform: boolean;
  readonly suppressAdjust: boolean | undefined;
  readonly vectorTransient: boolean | undefined;
  readonly sourceIsLinear: boolean | undefined;
  readonly sourceIsWorkingGamut: boolean | undefined;
  readonly sourceIntentApplied: boolean | undefined;
  readonly contentWindow: ContentWindow | undefined;
  readonly expandQuadToWindow: boolean | undefined;
  readonly maskFree: boolean | undefined;
}

/**
 * Unpack one layer's chain-map entry into the draw-params subset every
 * composite call site consumes. Returns `undefined` when the layer has no
 * resident source this frame (absent = nothing to draw — the caller's
 * historical `continue`).
 */
export function resolveDrawSourceParams<TAdjustCoverage>(
  src: PreparedSource | undefined,
  layer: LayerNode,
  maps: DrawSourceMaps,
  adjustCoverage: TAdjustCoverage | undefined,
): DrawSourceParams<TAdjustCoverage> | undefined {
  const texture = src?.texture;
  if (!texture) return undefined;
  // A mask-free prepass output (effect layers) already carries its masks baked
  // into the pixels — the compositor must not bind a second copy on top.
  const maskFree = src?.maskFree;
  const vmaskBake = maskFree ? undefined : maps.vmaskSources.get(layer.id);
  return {
    texture,
    maskTexture: maskFree ? undefined : maps.bmaskSources.get(layer.id),
    vmaskTexture: vmaskBake?.texture,
    vmaskWindow: vmaskBake?.window,
    adjustCoverage,
    solidUniform: src?.solidUniform === true,
    suppressAdjust: src?.suppressAdjust,
    vectorTransient: src?.vectorTransient,
    sourceIsLinear: src?.sourceIsLinear,
    sourceIsWorkingGamut: src?.sourceIsWorkingGamut,
    sourceIntentApplied: src?.sourceIntentApplied,
    contentWindow: src?.contentWindow,
    expandQuadToWindow: src?.expandQuadToWindow,
    maskFree,
  };
}

/** The geometry bundle `resolveLayerDrawGeometry` returns. */
export interface LayerDrawGeometry {
  readonly contentWidth: number;
  readonly contentHeight: number;
  /** Layer-local content offset, logical px (`resolveLayerGeometry` tuple). */
  readonly localOffset: readonly [number, number];
  /** Content-relative UVs scaled into PHYSICAL-texture space (POT buckets). */
  readonly physicalUvRect: readonly [number, number, number, number];
  readonly vmaskU: VmaskUniformFields;
}

/** The draw-params subset that feeds the geometry resolution. */
export interface LayerDrawGeometryInputs {
  /** Structural match of the draw params' `contentWindow` (basis optional). */
  readonly contentWindow?: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly basis?: 'asset' | 'content-local';
  };
  readonly expandQuadToWindow?: boolean;
  readonly vectorTransient?: boolean;
  readonly maskFree?: boolean;
  /** The mask-free-guarded vmask texture (`resolveDrawSourceParams.vmaskTexture`). */
  readonly vmaskTexture?: LayerTexture;
  readonly vmaskWindow?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

/**
 * The `resolveLayerGeometry` → `physicalUvRect` → `resolveVmaskUniform`
 * triple, computed ONCE for both draw passes. The UV scaling step is the
 * POT-bucket fix: `resolveLayerGeometry` normalises over the CONTENT size,
 * `textureSample` normalises over the ALLOCATED size, so content-relative UVs
 * must be scaled by `maxU/maxV` (a no-op on exact-size textures).
 */
export function resolveLayerDrawGeometry(
  layer: LayerNode,
  texture: LayerTexture,
  params: LayerDrawGeometryInputs,
): LayerDrawGeometry {
  const { contentWidth, contentHeight, localOffset, uvRect } = resolveLayerGeometry(
    layer,
    texture.width,
    texture.height,
    resolveLayerDprScale(layer, texture.width, params.vectorTransient),
    params.contentWindow,
    params.expandQuadToWindow === true,
    // The window's reporting basis is producer-stamped: 'asset' windows
    // convert to logical px through dprScale, 'content-local' windows
    // (vector/solid effect transients) are already logical.
    params.contentWindow?.basis ?? 'asset',
  );
  const physicalUvRect: readonly [number, number, number, number] = [
    uvRect[0] * texture.maxU,
    uvRect[1] * texture.maxV,
    uvRect[2] * texture.maxU,
    uvRect[3] * texture.maxV,
  ];
  // Mask-free prepass outputs skip vmask completely (already baked in).
  const vmaskU = resolveVmaskUniform(
    params.maskFree ? undefined : layer.vmask,
    contentWidth,
    contentHeight,
    !!params.vmaskTexture,
    params.vmaskWindow,
  );
  return { contentWidth, contentHeight, localOffset, physicalUvRect, vmaskU };
}
