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
 * Primitive Geometry Types: Bottom-most raw definitions of geometry engine
 * This is a leaf node file, depending on no other files in the project, used to break circular dependencies.
 */

export interface Point2D { x: number; y: number; }
export interface Size2D { w: number; h: number; }
export interface Dimensions { w: number; h: number; }

export type Rect = { x: number; y: number; w: number; h: number };

/** 
 * Branded Types: Enforce distinction of different coordinate spaces to prevent calculation errors
 */

// 1. World Space - Origin (0,0) at artboard center
export type WorldPoint = Point2D & { readonly __brand: 'world' };
export type WorldRect = Rect & { readonly __brand: 'world' };

// 2. Local Space - Origin (0,0) at top-left of layer or parent container
export type LocalPoint = Point2D & { readonly __brand: 'local' };
export type LocalRect = Rect & { readonly __brand: 'local' };

// 3. Viewport/Screen Space - Browser CSS px
export type ViewportPoint = Point2D & { readonly __brand: 'viewport' };
export type ViewportRect = Rect & { readonly __brand: 'viewport' };

/** Helper Casters (Type Casters) */
export const asWorldPoint = (p: { x: number, y: number }) => p as WorldPoint;
export const asWorldRect = (r: Rect) => r as WorldRect;

export const asLocalPoint = (p: { x: number, y: number }) => p as LocalPoint;
export const asLocalRect = (r: Rect) => r as LocalRect;

export const asViewportPoint = (p: { x: number, y: number }) => p as ViewportPoint;
export const asViewportRect = (r: Rect) => r as ViewportRect;

// Alias support
export type WPoint = WorldPoint;
export type WRect = WorldRect;
export type LPoint = LocalPoint;
export type LRect = LocalRect;
export type VPoint = ViewportPoint;
export type VRect = ViewportRect;

export const asWPoint = asWorldPoint;
export const asWRect = asWorldRect;
export const asLPoint = asLocalPoint;
export const asLRect = asLocalRect;
export const asVPoint = asViewportPoint;
export const asVRect = asViewportRect;

export const asWorldRectangle = asWorldRect;
export const asLocalRectangle = asLocalRect;

/**
 * Matrix data structure and operation interface
 */
export interface IMatrix3x3 {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;

  multiply(other: IMatrix3x3): IMatrix3x3;
  apply(p: Point2D): Point2D;
  inverse(): IMatrix3x3;
  translate(tx: number, ty: number): IMatrix3x3;
  scale(sx: number, sy?: number): IMatrix3x3;
  rotate(deg: number): IMatrix3x3;
  zoomAt(anchor: Point2D, ratio: number): IMatrix3x3;
  toCSS(): string;
}

export type GeometryOp = 'rotate_r' | 'rotate_l' | 'flip_h' | 'flip_v';

/**
 * Matrix constructor and static method contract
 */
export interface IMatrix3x3Constructor {
  new (a?: number, b?: number, c?: number, d?: number, tx?: number, ty?: number): IMatrix3x3;
  identity(): IMatrix3x3;
  translate(tx: number, ty: number): IMatrix3x3;
  scale(sx: number, sy?: number): IMatrix3x3;
  rotate(deg: number): IMatrix3x3;
  rotate90(steps: number): IMatrix3x3;
  flipH(): IMatrix3x3;
  flipV(): IMatrix3x3;
  zoomAt(anchor: Point2D, ratio: number): IMatrix3x3;
  transformRect(rect: Rect, container: Dimensions, op: GeometryOp): Rect;
  extractAABB(size: Dimensions, matrix: IMatrix3x3): Rect;
}

/**
 * Shape Engine Models: Unified shape engine models
 */
export type ShapeType = 'rect' | 'circle' | 'path';

export interface Shape {
  type: ShapeType;
  rect: Rect;            // Bounding box of shape (basic definition)
  antiAliased?: boolean; // New: whether anti-aliasing is enabled (defaults to true)
  pathData?: string;     // Data for complex paths (e.g. SVG Path)
  /**
   * Feather radius (px) carried by a fragment's `visibleShape`.
   * When >0, the implicit shape mask synthesised in `SceneAssembler` renders a soft
   * edge instead of a hard clip. Absent/0 = hard edge (the crop rect IS the shape),
   * the zero-regression default for every non-feathered shape. NOT part of the
   * boolean topology — feathering never changes which pixels are inside the shape,
   * only the alpha falloff at its boundary.
   */
  featherPx?: number;
}

/**
 * WorldShapeDescriptor: Shape descriptor in world coordinate system (used for selection)
 */
export interface WorldShape extends Shape {
  readonly __brand: 'world';
  rect: WorldRect; 
}

/**
 * LocalShapeDescriptor: Shape descriptor in layer local coordinate system (used for mask)
 */
export interface LocalShape extends Shape {
  readonly __brand: 'local';
  rect: LocalRect; 
}

export const asWorldShape = (rect: Rect, type: ShapeType = 'rect', antiAliased: boolean = true): WorldShape => ({
  type,
  rect: asWorldRect(rect),
  antiAliased
} as WorldShape);

export const asLocalShape = (rect: Rect, type: ShapeType = 'rect', antiAliased: boolean = true): LocalShape => ({
  type,
  rect: asLocalRect(rect),
  antiAliased
} as LocalShape);

/**
 * Polygon Engine Models: Independent vector polygon for irregular selection
 *
 * Polygon is a SEPARATE type system from Shape:
 *   - Shape  = single rect + regular type (rect/circle/path), used by render pipeline / hit-test / clip masks
 *   - Polygon = multi-ring point set (outer ring + inner holes), used by lasso / wand / AI matting selections
 *
 * The two MUST NOT be merged into a union type.
 */

/**
 * Polygon: base structure (multi-ring with bounds)
 *
 *  - rings[0]    = outer ring (winding: CW / clockwise)
 *  - rings[1..]  = inner holes (winding: CCW / counter-clockwise)
 *  - evenodd fill rule applies, so disconnected rings are also supported
 *  - bounds      = axis-aligned bounding box, computed at construction time and frozen,
 *                  used for SVG group projection / hit-test optimization / offscreen mask sizing
 */
export interface Polygon {
  rings: Point2D[][];
  rect: Rect;
  /**
   * Whether polygon rendering and rasterization uses anti-aliasing (smooth float lines).
   * Defaults to true; when false, represents a stair-stepped/pixelated boundary.
   */
  antiAliased?: boolean;
}

/** Polygon in canvas-local coordinate space (origin (0,0) at canvas top-left). */
export interface LocalPolygon extends Polygon {
  readonly __brand: 'local';
  rings: LocalPoint[][];
  rect: LocalRect;
}

/**
 * Polygon in world coordinate space (origin (0,0) at artboard center).
 * Used purely as a transit form: frame-local -> world -> layer-local.
 */
export interface WorldPolygon extends Polygon {
  readonly __brand: 'world';
  rings: WorldPoint[][];
  rect: WorldRect;
}

/** Polygon casters (parallel to asLocalShape / asWorldShape). */
export const asLocalPolygon = (
  rings: LocalPoint[][],
  rect: LocalRect,
  antiAliased: boolean = true
): LocalPolygon => ({
  rings,
  rect,
  antiAliased,
  __brand: 'local'
} as LocalPolygon);

export const asWorldPolygon = (
  rings: WorldPoint[][],
  rect: WorldRect,
  antiAliased: boolean = true
): WorldPolygon => ({
  rings,
  rect,
  antiAliased,
  __brand: 'world'
} as WorldPolygon);

/**
 * Type guard: discriminates whether a selection is a Polygon or a Shape.
 * Used by LayerService and commands to handle the `LocalShape | LocalPolygon` union.
 */
export function isPolygon(sel: LocalShape | LocalPolygon): sel is LocalPolygon;
export function isPolygon(sel: WorldShape | WorldPolygon): sel is WorldPolygon;
export function isPolygon(sel: Shape | Polygon): sel is Polygon {
  return Array.isArray((sel as Polygon).rings);
}

/**
 * Color primitives
 *
 * `GamutId` — the canonical source physical color gamut of a set of pixels.
 * Consumed as a per-asset tag by the wide-gamut pipeline and GPU matrix conversion.
 */
export type GamutId = 'srgb' | 'display-p3' | 'adobe-rgb' | 'prophoto-rgb' | 'rec2020';

/**
 * Defensive type guard & mapper for color space strings.
 * Safely normalizes arbitrary ICC detected color spaces into canonical GamutId.
 * Fallback to 'srgb' if unrecognized or non-RGB (e.g. CMYK / grayscale / unknown).
 */
export function toGamutId(val: string | null | undefined): GamutId {
  switch (val) {
    case 'display-p3':
    case 'p3':
      return 'display-p3';
    case 'adobe-rgb':
    case 'adobergb':
      return 'adobe-rgb';
    case 'prophoto-rgb':
    case 'prophoto':
    case 'romm-rgb':
      return 'prophoto-rgb';
    case 'rec2020':
    case 'bt2020':
      return 'rec2020';
    case 'srgb':
    default:
      return 'srgb';
  }
}

/**
 * `RenderIntent` — the OUT-OF-BOX rendering intent a source asset must receive at
 * composite time, carried FORWARD as an explicit provenance axis from the ingest
 * decision (RAW Route B §5.3, method (a)). It is orthogonal to `GamutId`/`trc`
 * (which describe the pixels' physical color identity): those say *what the pixels
 * are*, this says *how they must be rendered to be looked at*.
 *
 * - `'sdr'`     — already Display-Referred (JPEG/PNG/text/vector, camera-baked
 *                 look): pass through untouched. This is the OMITTED default —
 *                 nothing that is not explicitly tagged ever gets tone-mapped.
 * - `'filmic'`  — Scene-Referred linear RAW with no vendor curve: apply the generic
 *                 Filmic S-curve in the shader.
 * - `'dng-lut'` — RAW carrying a DNG `ProfileToneCurve`: sample that 1D LUT (falls
 *                 back to Filmic when the LUT is absent). Reserved; wired later.
 *
 * Consumed lazily as a per-asset tag; the GPU shader stage that reads it (via the
 * `render_intent` flags nibble) lands with `sourceNormalize.ts`.
 */
export type RenderIntent = 'sdr' | 'filmic' | 'dng-lut';


