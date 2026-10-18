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

/** Marker primitive type identifier. */
export type MarkerKind = 'rect' | 'arrow' | 'ellipse';
// Future: | 'line' | 'star' | ... (plugin-local; see module docs)

/**
 * Base marker descriptor — common properties for all marker kinds.
 * Persisted as `Layer.markerData`.
 */
export interface MarkerDataBase {
  kind: MarkerKind;

  /** Stroke (border) properties */
  stroke: {
    color: ColorValue;  // structured foreground colour (wide-gamut currency)
    width: number;     // px, range [1, 50]
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
 * Arrow marker data.
 *
 * Geometry defined by two endpoints in layer-local coordinates.
 * `Layer.bounding` is the axis-aligned bounding box of these two points
 * (expanded by strokeWidth / 2 + arrowhead size).
 *
 * `Layer.cx/cy` is the world-space center of the bounding box.
 * Endpoints are relative to the bounding box top-left (local space).
 */
export interface ArrowMarkerData extends MarkerDataBase {
  kind: 'arrow';
  /** Start point in layer-local coordinates (relative to bounding top-left) */
  tail: { x: number; y: number };
  /** End point (arrowhead) in layer-local coordinates */
  head: { x: number; y: number };
  /** Arrowhead size multiplier (relative to strokeWidth). Default 3. */
  headScale: number;
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

/** Discriminated union of all marker data variants */
export type MarkerData = RectMarkerData | ArrowMarkerData | EllipseMarkerData;
// Future: | LineMarkerData | ...

// Attach the payload to the core Layer model by declaration merging. The field
// NAME is the persistence contract; the TYPE is plugin property.
declare module '@opengpex/editor/core/types' {
  interface Layer {
    /** Marker tool data — only present when type='vector' and created by the Marker Tool. */
    markerData?: MarkerData;
  }
}
