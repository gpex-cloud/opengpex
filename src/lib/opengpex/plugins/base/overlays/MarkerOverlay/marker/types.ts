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
 * types.ts — the marker tool's payload model, OWNED by this plugin.
 *
 * The core `Layer` model carries the `markerData` FIELD NAME (that name is the
 * `.gpex` persistence contract — never rename it), but the type definition
 * lives here and is attached to `Layer` by declaration merging below. The
 * engine and core types have zero knowledge of this payload's shape; any
 * module compiled together with this plugin sees the fully-typed field.
 *
 * Adding a new marker kind is entirely plugin-local: add a variant interface
 * here, extend the `MarkerKind` union and `MarkerData` union, and register a
 * `MarkerDefinition` in `marker/registry.ts`. NOTE: a kind whose geometry is
 * not expressible by the existing engine `SdfPrimitive` vocabulary additionally
 * requires an engine-level primitive (see the vector-source plan) or falls
 * back to the raster path.
 *
 * @module plugins/base/overlays/MarkerOverlay/marker/types
 */

import type { ColorValue } from '@opengpex/editor/core/engine/color';
import type { SdfPrimitive } from '@opengpex/editor/core/engine/pipeline/scene/Scene';

/** Marker primitive type identifier. */
export type MarkerKind = 'rect' | 'arrow' | 'ellipse' | 'line' | 'darrow' | 'star' | 'polygon' | 'callout';

/**
 * Base marker descriptor — common properties for all marker kinds.
 * Persisted as `Layer.markerData`.
 */
export interface MarkerDataBase {
  kind: MarkerKind;

  /** Stroke (border) properties */
  stroke: {
    color: ColorValue;  // structured foreground colour (wide-gamut currency)
    width: number;     // px, >= 1; the panel's ceiling scales with the canvas (see getDynamicMarkerStrokeMax)
  };

  /** Fill properties (for closed shapes like rect/ellipse) */
  fill: {
    color: ColorValue; // structured foreground colour (wide-gamut currency)
    opacity: number;   // 0–1, 0 = no fill
  };

  /**
   * Edge anti-aliasing toggle. `undefined`/`true` = smoothstep AA (default,
   * zero-regression); `false` = hard edge (single-pixel step, 8-bit art style).
   * Persisted with the layer's markerData.
   */
  antiAliased?: boolean;
}

/**
 * Rect marker data.
 *
 * Geometry is implicitly defined by `Layer.bounding` (w × h) —
 * the rect always fills the entire layer bounding box.
 * No extra geometry fields needed.
 */
export interface RectMarkerData extends MarkerDataBase {
  kind: 'rect';
  /** Corner radius in px. 0 = sharp corners. */
  cornerRadius: number;
}

/**
 * Segment-family marker data: the two layer-local endpoints ALL segment kinds
 * share (line / arrow / darrow). `Layer.bounding` is the TIGHT painted AABB —
 * round caps, head triangles and a 1px AA margin — computed by
 * `segmentTightBounding`; the endpoints are relative to the bounding top-left.
 * `Layer.cx/cy` is the world-space center of the bounding box.
 */
export interface SegmentEndpoints {
  /** First endpoint in layer-local coordinates (relative to bounding top-left). */
  a: { x: number; y: number };
  /** Second endpoint in layer-local coordinates. */
  b: { x: number; y: number };
}

/** Head length factor shared by the headed segment kinds (arrow / darrow). */
export interface SegmentHeadScale {
  /** Arrowhead size multiplier (relative to strokeWidth). Default 3. */
  headScale: number;
}

/**
 * Arrow marker data: head at `b` only.
 */
export interface ArrowMarkerData extends MarkerDataBase, SegmentEndpoints, SegmentHeadScale {
  kind: 'arrow';
}

/**
 * Ellipse marker data.
 *
 * Geometry is implicitly defined by `Layer.bounding` (w × h) — the ellipse is
 * inscribed in the layer bounding box (rx = w/2, ry = h/2). No extra geometry
 * fields needed (same model as rect, minus cornerRadius).
 */
export interface EllipseMarkerData extends MarkerDataBase {
  kind: 'ellipse';
}

/**
 * Line marker data: a plain stroke between two layer-local endpoints, the
 * segment family minus the heads.
 */
export interface LineMarkerData extends MarkerDataBase, SegmentEndpoints {
  kind: 'line';
}

/**
 * Double-arrow marker data: heads at BOTH ends. Same endpoint, tight-bounding
 * and headScale model as the single arrow.
 */
export interface DarrowMarkerData extends MarkerDataBase, SegmentEndpoints, SegmentHeadScale {
  kind: 'darrow';
}

/**
 * Star marker data: a regular star with EXACTLY n tips. `points` is the
 * number of spikes; the spike shape is not a free parameter — new draws are
 * the TRUE star polygon (chords between alternate tips, straight edges, the
 * inner hole's edges parallel to them), rendered through the engine's radial
 * primitive at the derived sharpness `2n/(n−2)`.
 *
 * `sharpness` is LEGACY-ONLY: old documents carry the old valley-radius
 * parameter (its default 3.2 produced a slightly fat, bent-edged near-star);
 * it is honoured verbatim so old pixels never change, and new draws omit it.
 *
 * Bounding semantics (`bounding`): absent/false = LEGACY — the bounding is
 * the inscribed-ellipse circumscribed box and the painted star does not fill
 * it. true = the bounding IS the painted content's AABB: the shape is solved
 * in a content-filling ellipse (`contentFillEllipse`, multipliers riding on
 * the star primitive's shapeParams), so the drawn box hugs the ink. New
 * draws stamp true at birth; legacy records keep the old box unchanged.
 */
export interface StarMarkerData extends MarkerDataBase {
  kind: 'star';
  points: number;
  /** LEGACY-ONLY valley parameter; new draws omit it and derive the true star. */
  sharpness?: number;
  bounding?: boolean;
}

/**
 * Regular polygon marker data: `sides` ≥ 3. Rendered through the star
 * primitive at sharpness 2 (its regular n-gon end), so no extra engine
 * primitive exists for it. Bounding semantics (`bounding`) mirror the star
 * kind: absent/false = legacy inscribed-ellipse circumscribed box; true =
 * content-filling ellipse, the bounding IS the painted n-gon's AABB.
 */
export interface PolygonMarkerData extends MarkerDataBase {
  kind: 'polygon';
  sides: number;
  bounding?: boolean;
}

/**
 * Callout (speech bubble) marker data: a rounded-rect body plus a tail
 * triangle whose apex is `tip`. All coordinates are layer-local; `Layer.bounding`
 * is the tight ink AABB of body ∪ tip plus the fixed AA margin (the stroke
 * grows inward and never widens the box), so the body does NOT fill the
 * bounding box — it is stored explicitly.
 */
export interface CalloutMarkerData extends MarkerDataBase {
  kind: 'callout';
  /** Body rectangle in layer-local coordinates */
  body: { x: number; y: number; w: number; h: number };
  /** Tail apex in layer-local coordinates */
  tip: { x: number; y: number };
  /** Body corner radius in px */
  cornerRadius: number;
}

// ─── Render-side contracts (pure data; consumed by shapes/<kind>/render.ts) ────

/** Minimal bounding contract — accepts both live Layer.bounding and descriptors. */
export interface MarkerBounding {
  w: number;
  h: number;
}

/**
 * What a shape contributes to the engine's SDF uniform: the primitive to solve,
 * its geometry scalars (see `SdfShapeParams.shapeParams` for each primitive's
 * layout) and, for arrow-like primitives, the head length factor.
 */
export interface SdfGeometry {
  prim: SdfPrimitive;
  shapeParams: readonly number[];
  headScale?: number;
}

/** Kinds that carry a `cornerRadius` (the panel's corner-radius control applies). */
export type CornerRadiusMarkerData = RectMarkerData | CalloutMarkerData;

export function hasCornerRadius(data: MarkerData): data is CornerRadiusMarkerData {
  return data.kind === 'rect' || data.kind === 'callout';
}

/** Discriminated union of all marker data variants */
export type MarkerData =
  | RectMarkerData
  | ArrowMarkerData
  | EllipseMarkerData
  | LineMarkerData
  | DarrowMarkerData
  | StarMarkerData
  | PolygonMarkerData
  | CalloutMarkerData;

/** The straight-line family (line / arrow / darrow): one shared geometry model. */
export type SegmentMarkerData = ArrowMarkerData | LineMarkerData | DarrowMarkerData;

// Attach the payload to the core Layer model by declaration merging. The field
// NAME is the persistence contract; the TYPE is plugin property.
declare module '@opengpex/editor/core/types' {
  interface Layer {
    /** Marker tool data — only present when type='vector' and created by the Marker Tool. */
    markerData?: MarkerData;
  }
}
