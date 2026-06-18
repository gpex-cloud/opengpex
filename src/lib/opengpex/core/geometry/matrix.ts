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
 * Transformation Algorithm: Industrial-grade 3x3 affine transformation matrix engine
 * 
 * This module implements all geometric transformation logic in 2D space, including rotation, scaling, translation, and D4 group mirroring.
 * Through matrix multiplication (Matrix Multiplication), we can handle complex nested transformations uniformly.
 * 
 * Matrix structure:
 * [ a  c  tx ]
 * [ b  d  ty ]
 * [ 0  0  1  ]
 */

import { IMatrix3x3 } from '@opengpex/editor/core/types';

export interface Point2D { x: number; y: number; }
export interface Size2D { w: number; h: number; }
export interface Rect2D extends Point2D, Size2D {}

export type GeometryOp = 'rotate_r' | 'rotate_l' | 'flip_h' | 'flip_v';

export class Matrix3x3 implements IMatrix3x3 {
  constructor(
    public a: number = 1, public b: number = 0,
    public c: number = 0, public d: number = 1,
    public tx: number = 0, public ty: number = 0
  ) {}

  static identity() { return new Matrix3x3(); }

  /**
   * Matrix multiplication: this * other
   */
  multiply(other: IMatrix3x3): Matrix3x3 {
    return new Matrix3x3(
      this.a * other.a + this.c * other.b,
      this.b * other.a + this.d * other.b,
      this.a * other.c + this.c * other.d,
      this.b * other.c + this.d * other.d,
      this.a * other.tx + this.c * other.ty + this.tx,
      this.b * other.tx + this.d * other.ty + this.ty
    );
  }

  /**
   * Apply transformation to a point: P' = M * P
   */
  apply(p: Point2D): Point2D {
    return {
      x: this.a * p.x + this.c * p.y + this.tx,
      y: this.b * p.x + this.d * p.y + this.ty
    };
  }

  /**
   * Inverse matrix (used to map from screen coordinates back to local coordinates)
   * Robustness optimization: if the matrix degrades (is irreversible), return the identity matrix and warn to avoid application crash.
   */
  inverse(): Matrix3x3 {
    const det = this.a * this.d - this.b * this.c;
    if (Math.abs(det) < 1e-10) {
      console.warn('[Matrix3x3] Matrix is singular and cannot be inverted. Falling back to Identity.');
      return Matrix3x3.identity();
    }
    
    const invDet = 1 / det;
    return new Matrix3x3(
      this.d * invDet,
      -this.b * invDet,
      -this.c * invDet,
      this.a * invDet,
      (this.c * this.ty - this.d * this.tx) * invDet,
      (this.b * this.tx - this.a * this.ty) * invDet
    );
  }

  // --- Factory methods: Atomic transformations ---

  static translate(tx: number, ty: number) {
    return new Matrix3x3(1, 0, 0, 1, tx, ty);
  }

  static scale(sx: number, sy: number = sx) {
    return new Matrix3x3(sx, 0, 0, sy, 0, 0);
  }

  static rotate(deg: number) {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.round(Math.cos(rad) * 1e10) / 1e10;
    const sin = Math.round(Math.sin(rad) * 1e10) / 1e10;
    return new Matrix3x3(cos, sin, -sin, cos, 0, 0);
  }

  /**
   * 90-degree step rotation optimized for D4 group (no precision loss)
   */
  static rotate90(steps: number) {
    const s = ((steps % 4) + 4) % 4;
    if (s === 1) return new Matrix3x3(0, 1, -1, 0, 0, 0); // 90 CW
    if (s === 2) return new Matrix3x3(-1, 0, 0, -1, 0, 0); // 180
    if (s === 3) return new Matrix3x3(0, -1, 1, 0, 0, 0); // 270 CW
    return Matrix3x3.identity();
  }

  static flipH() { return new Matrix3x3(-1, 0, 0, 1, 0, 0); }
  static flipV() { return new Matrix3x3(1, 0, 0, -1, 0, 0); }

  /**
   * Composite matrix for scaling at a specific point
   * Logic: M = Translate(anchor) * Scale(ratio) * Translate(-anchor)
   */
  static zoomAt(anchor: Point2D, ratio: number): Matrix3x3 {
    return Matrix3x3.translate(anchor.x, anchor.y)
      .multiply(Matrix3x3.scale(ratio))
      .multiply(Matrix3x3.translate(-anchor.x, -anchor.y));
  }

  // --- Instance operators: Supports chainable calls ---

  /** Chained translation */
  translate(tx: number, ty: number): Matrix3x3 {
    return this.multiply(Matrix3x3.translate(tx, ty));
  }

  /** Chained scaling */
  scale(sx: number, sy: number = sx): Matrix3x3 {
    return this.multiply(Matrix3x3.scale(sx, sy));
  }

  /** Chained rotation */
  rotate(deg: number): Matrix3x3 {
    return this.multiply(Matrix3x3.rotate(deg));
  }

  /** Chained scaling at specific point */
  zoomAt(anchor: Point2D, ratio: number): Matrix3x3 {
    return this.multiply(Matrix3x3.zoomAt(anchor, ratio));
  }

  /**
   * Transform rectangle (based on D4 symmetry operations)
   */
  static transformRect(rect: Rect2D, container: Size2D, op: GeometryOp): Rect2D {
    const { x, y, w, h } = rect;
    const { w: oldW, h: oldH } = container;
    switch (op) {
      case 'rotate_r': return { x: oldH - y - h, y: x, w: h, h: w };
      case 'rotate_l': return { x: y, y: oldW - x - w, w: h, h: w };
      case 'flip_h': return { x: oldW - x - w, y, w, h };
      case 'flip_v': return { x, y: oldH - y - h, w, h };
      default: return rect;
    }
  }

  /**
   * Extract Axis-Aligned Bounding Box (AABB)
   * Logic: Calculates the bounding rectangle by transforming four corners.
   */
  static extractAABB(size: Size2D, matrix: Matrix3x3): Rect2D {
    const halfW = size.w / 2;
    const halfH = size.h / 2;
    const corners = [
      matrix.apply({ x: -halfW, y: -halfH }),
      matrix.apply({ x: halfW, y: -halfH }),
      matrix.apply({ x: -halfW, y: halfH }),
      matrix.apply({ x: halfW, y: halfH })
    ];
    
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of corners) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    
    const x = Math.floor(minX);
    const y = Math.floor(minY);
    return {
      x,
      y,
      w: Math.ceil(maxX) - x,
      h: Math.ceil(maxY) - y
    };
  }

  /**
   * Convert to standard CSS matrix(a, b, c, d, tx, ty) string
   */
  toCSS(): string {
    return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.tx}, ${this.ty})`;
  }
}

