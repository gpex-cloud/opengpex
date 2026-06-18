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

export interface TileMetadata {
  width: number;
  height: number;
  tileSize: number;
  cols: number;
  rows: number;
  levels: number;
  isTiled: boolean; // Whether tiling is enabled (small images can be false for fast rendering)
  contentBounds?: LocalRect; // Bounding box of non-transparent content (local coordinates)
  isPeeled?: boolean;      // Marker indicating if region is peeled
  dprScale?: number;       // Ratio of physical asset dimensions to logical dimensions
}

/**
 * Wraps raw tile rendering instruction for cross-layer transmission (Data-Driven Rendering)
 */
export interface TileData {
  bitmap: ImageBitmap | HTMLImageElement;
  x: number;
  y: number;
  scale: number;
  overlap: number;
}

/**
 * ClipDescriptor: Clip instruction descriptor (used to abstract rendering pipeline)
 */
export interface ClipDescriptor {
  shape: LocalShape;
  inverted: boolean;
  /** Pre-compiled Path2D cache (worker/render perf optimization) */
  __compiledPath2D?: Path2D;
}

/**
 * Shape Engine Models: Unified shape engine models
 */
export type ShapeType = 'rect' | 'circle' | 'path';

export interface Shape {
  type: ShapeType;
  rect: Rect;            // Bounding box of shape (basic definition)
  hardEdge: boolean;     // Physical "aliased step mode" switch
  antiAliased?: boolean; // New: whether anti-aliasing is enabled (defaults to true)
  pathData?: string;     // Data for complex paths (e.g. SVG Path)
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
  hardEdge: false,
  antiAliased
} as WorldShape);

export const asLocalShape = (rect: Rect, type: ShapeType = 'rect', antiAliased: boolean = true): LocalShape => ({
  type,
  rect: asLocalRect(rect),
  hardEdge: false,
  antiAliased
} as LocalShape);

