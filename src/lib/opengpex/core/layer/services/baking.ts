/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
 * details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { Frame, Layer, LocalShape, asLocalShape } from '@opengpex/editor/core/types';
import { ringsToPathData } from '@opengpex/editor/core/geometry/operators/point2d';
import { traceAlphaRings } from '@opengpex/editor/core/geometry/operators/alpha';
import { blobToImageData } from '@opengpex/editor/core/engine/utils/pixel-utils';
import type { CompositedImage } from '@opengpex/editor/core/engine/types';
import type { PixelService, AssetService, GeometryService } from '@opengpex/editor/core/types';

/**
 * baking.ts — the physical-bake record family: the ONE pipeline that turns a
 * set of participant layers into a baked asset plus a well-formed product
 * layer record ("physical" layer: the layer OWNS its pixels, as opposed to
 * a logical fragment that crops a shared source asset).
 *
 * Domain separation (why this is NOT in clipping.ts): clipping.ts is the
 * SELECTION-CUT family (selection ∩ source layer → fragment record); this
 * family is the BAKE-AND-PROMOTE family. Whole-layer merges (mergeDown /
 * mergeVisible / rasterize), peel commits and fragment transform bakes all
 * sit here — none of them are fragments semantically, and every one of them
 * needs the exact same trio (compositeLayers → storeBundle → loadBitmap
 * cache-warm) plus the same product-record conventions.
 *
 * Multi-layer composition itself lives BELOW this layer: both this family
 * and clipping/resizing delegate to the render engine
 * (`pixels.render.compositeLayers` / `compositeResizedLayers`). The split
 * between the three service families is problem domain — selection-cut vs
 * resize vs bake-and-promote — never layer count.
 *
 * Structural note: `resizing.ts :: flattenResample` is a structural cousin
 * (compositeResized → storeBundle → pose-reset patch) but carries its own
 * target-size semantics (layer AABB × scale, compositeResizedLayers), so it
 * intentionally STAYS in the resize family; only the conventions overlap.
 *
 * Purity contract: nothing here reads frame.drafts (no peel/pen session
 * knowledge), writes confinement, touches focus/history, or uses the fast
 * facade. Callers (plugin command shells, advanced commands) decide WHEN and
 * on WHOM to bake; this family decides HOW the baked product is recorded.
 *
 * Naming: `bakeToAsset` / `bakedLayerPatch` are
 * placeholders pending the dedicated rename round (R2, user-led).
 */

/** Options for bakeToAsset — currently only the fragment-transform bake passes any. */
export interface BakeToAssetOptions {
  /** Composite ROI in frame-local coordinates. Absent = full-frame composite. */
  roi?: LocalShape;
  /**
   * Per-layer pose overrides (scale / scaleY / local-frame rotation seam).
   * The same channel the live fragment-transform preview used, so baked
   * pixels ≡ preview pixels by construction.
   */
  poseOverrides?: Record<string, { scale?: number; scaleY?: number; sourceAngle?: number }>;
}

/** Result of bakeToAsset: the registered asset plus the composite's bounds. */
export interface BakeToAssetResult {
  /** The raw composite (plain-data bitmap + bounds), for callers needing pixels. */
  composited: CompositedImage;
  assetId: string;
  url: string;
  bounds: { x: number; y: number; w: number; h: number };
}

/** Options for bakedLayerPatch — product-record conventions per caller. */
export interface BuildPhysicalPatchOptions {
  /**
   * Half-pixel-align the product center (`Math.round(v * 2) / 2`). The
   * fragment-transform bake uses this (same convention as resizeCanvas);
   * full-frame merges keep the raw bounds center.
   */
  snapHalf?: boolean;
  /**
   * Flip to keep on the product. A transform bake that mirrored the pixels
   * must NOT reset flip — toggling it here would mirror the baked asset a
   * second time. Absent = factory default (no flip), the merge behavior.
   */
  flip?: { h: boolean; v: boolean };
  /**
   * snap-to-birth anchor. The transform bake re-anchors on the baked pose so
   * a later snap does not fly back to the pre-bake position. Absent = unset
   * (the factory default applies).
   */
  birthCenter?: { cx: number; cy: number };
  /**
   * Traced fragment contour (absolute-coordinate SVG pathData, product-local
   * px). When present the visibleShape becomes a full-bounds PATH carrying
   * this pathData instead of a plain rect: the product record then describes
   * the fragment's TRUE contour (for Refocus etc.) while the pixels already
   * carry the same edge in their alpha — the path only clips what is already
   * transparent. Absent = full-bounds rect (regular selections, fallback).
   */
  outlinePath?: string;
}

export function createBakeOperations(
  geometry: GeometryService,
  pixels: PixelService,
  assets: AssetService
) {
  // geometry is unused today but kept in the factory signature for parity
  // with the other service families (and for the R3 outline geometry needs).
  void geometry;

  /**
   * bakeToAsset — the trio every bake site used to hand-roll: composite the
   * participants through the single WebGPU RenderGraph, register the result
   * as a content-addressed asset, and warm the decoded bitmap BEFORE the
   * caller's state update (so the next render frame hits the cache — no
   * flash). Returns everything a caller needs to promote the product.
   */
  async function bakeToAsset(
    frame: Frame,
    participants: Layer[],
    opts?: BakeToAssetOptions
  ): Promise<BakeToAssetResult> {
    const composited: CompositedImage = await pixels.render.compositeLayers(
      participants,
      frame,
      opts?.roi,
      opts?.poseOverrides ? { poseOverrides: opts.poseOverrides } : undefined,
    );
    const { assetId, url } = await assets.storeBundle(composited);

    // Ensure the bitmap is decoded into SourceBitmapCache BEFORE the caller's
    // state update. storeBundle() registers the asset (its onRegistered hook
    // warms both caches); loadBitmap is cache-first so this is instant.
    await pixels.image.loadBitmap(url);

    return { composited, assetId, url, bounds: composited.bounds };
  }

  /**
   * bakedLayerPatch — the product-record conventions shared by every
   * physical bake, mirroring `resetWithBounds` (layer/index.ts): pose resets
   * to factory values (the pose lives in the pixels now), the crop releases
   * to a full-bounds rect (the visible edge is the asset's own alpha from
   * here on), and the declarative grade chain is stripped (the composite
   * already baked every participant's adjustMasks — carrying one forward
   * would grade twice). Callers layer their specifics on top (src/assetId,
   * name, metadata lineage).
   */
  function bakedLayerPatch(
    bounds: { x: number; y: number; w: number; h: number },
    opts?: BuildPhysicalPatchOptions
  ): Partial<Layer> {
    const snap = (v: number) => (opts?.snapHalf ? Math.round(v * 2) / 2 : v);
    const cx = snap(bounds.x + bounds.w / 2);
    const cy = snap(bounds.y + bounds.h / 2);
    return {
      cx,
      cy,
      bounding: { w: bounds.w, h: bounds.h },
      // Outline path present: full-bounds PATH (the `bounding` == rect size
      // invariant is load-bearing — SceneAssembler normalises the path by the
      // rect origin). Absent: plain full-bounds rect.
      visibleShape: opts?.outlinePath
        ? {
            type: 'path',
            rect: { x: 0, y: 0, w: bounds.w, h: bounds.h },
            antiAliased: true,
            pathData: opts.outlinePath,
            __brand: 'local',
          } as unknown as LocalShape
        : asLocalShape({ x: 0, y: 0, w: bounds.w, h: bounds.h }),
      scale: 1,
      rotation: 0,
      ...(opts?.flip ? { flip: opts.flip } : {}),
      ...(opts?.birthCenter ? { birthCenter: opts.birthCenter } : {}),
      adjustMasks: undefined,
    };
  }

  /**
   * traceAlphaOutline — rebuild a baked product's contour from its own pixel
   * alpha. Reads the composite's 8-bit display bitmap, traces the opaque
   * region (threshold 0, simplification epsilon 1.0 — the same parameters
   * "Select from Alpha" uses) and serialises the rings to pathData in
   * composite space, which for a fresh bake IS the product's local space
   * (visibleShape rect starts at 0,0 and `bounding` == bitmap size).
   *
   * Failure-safe by contract: any decode or trace failure returns null and
   * the caller keeps the full-bounds rect — Refocus degrades to the bounding
   * box (today's behavior), the landing itself is never blocked.
   */
  async function traceAlphaOutline(
    composited: CompositedImage,
  ): Promise<string | null> {
    try {
      const imageData = await blobToImageData(composited.displayBlob);
      const rings = traceAlphaRings(imageData.data, imageData.width, imageData.height, 0, 1.0);
      if (!rings || rings.length === 0) return null;
      return ringsToPathData(rings);
    } catch {
      return null;
    }
  }

  /**
   * The physical-layer declaration (metadata.physicalPixels) is deliberately
   * NOT a helper here: every write site has different merge semantics —
   * fresh-object composition (peel commit), session-pointer merge (transform
   * bake), lineage merge (resetWithBounds), logical marker (fragment paths).
   * Each writes its one-line spread inline; the KEY NAME contract is pinned
   * by the declaration guard test instead of by a wrapper.
   */

  return { bakeToAsset, bakedLayerPatch, traceAlphaOutline };
}
