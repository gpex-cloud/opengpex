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

import {
  LocalShape, Layer, Frame, Shape, Rect, Point2D,
  WorldShape, asWorldRect, asLocalRect
} from '@opengpex/editor/core/types';
import { getLayerWorldMatrix } from './transform';
import { getLayerLocalAABB, getRectIntersection, getLayerBoundingBox, getMultiRectUnion } from './space';
import { snapToPixel } from './snapping';

/**
 * frameLocalToLayerLocal: Projects selection shape under artboard space (Frame) to layer (Layer) local space
 */
export function frameLocalToLayerLocal(shape: Shape, frame: Frame, layer: Layer): LocalShape {
  const world = localToWorldShape(shape, frame);
  return worldToLocalShape(world, layer);
}

/**
 * layerLocalToFrameLocal: Projects layer (Layer) local shape to artboard space (Frame)
 */
export function layerLocalToFrameLocal(shape: Shape, layer: Layer, frame: Frame): LocalShape {
  const world = localToWorldShape(shape, layer);
  return worldToLocalShape(world, frame);
}

/**
 * intersectWithLayer: Calculates the intersection of the selection shape with the layer's visible area, returning the intersection shape and center world coordinates
 * (i.e. original LayerService.deriveLogical, now moved to the geometry engine with swapped parameter order)
 */
export function intersectWithLayer(shape: LocalShape, layer: Layer): { visibleShape: LocalShape, center: Point2D } | null {
  const parentVisibleRect = layer.visibleShape!.rect;
  const intersection = getRectIntersection(shape.rect, parentVisibleRect);

  if (!intersection) return null;

  const s = snapToPixel(intersection) as Rect;
  const M_orig = getLayerWorldMatrix(layer);
  const vCenter = M_orig.apply({ x: s.x + s.w / 2, y: s.y + s.h / 2 });

  const visibleShape = { ...shape, rect: s } as LocalShape;

  return { visibleShape, center: { x: vCenter.x, y: vCenter.y } as Point2D };
}



/**
 * Project shape from local to world space
 */
export function localToWorldShape(shape: Shape, source: Layer | Frame): WorldShape {
  if ('__brand' in shape && shape.__brand === 'world') return shape as WorldShape;

  let worldRect;
  if ('type' in source && (source.type === 'image' || source.type === 'text' || source.type === 'vector' || source.type === 'color')) {
    const wm = getLayerWorldMatrix(source as Layer);
    const x = (shape.rect.x * wm.a) + (shape.rect.y * wm.c) + wm.tx;
    const y = (shape.rect.x * wm.b) + (shape.rect.y * wm.d) + wm.ty;
    worldRect = asWorldRect({ x, y, w: shape.rect.w * wm.a, h: shape.rect.h * wm.d });
  } else {
    const f = source as Frame;
    worldRect = asWorldRect({
      x: shape.rect.x - f.canvas.w / 2,
      y: shape.rect.y - f.canvas.h / 2,
      w: shape.rect.w,
      h: shape.rect.h
    });
  }

  return { ...shape, rect: worldRect, __brand: 'world' } as WorldShape;
}

/**
 * Project world shape to local space
 */
export function worldToLocalShape(shape: WorldShape, target: Layer | Frame): LocalShape {
  let localRect;
  if ('type' in target && (target.type === 'image' || target.type === 'text' || target.type === 'vector' || target.type === 'color')) {
    const wm = getLayerWorldMatrix(target as Layer);
    localRect = getLayerLocalAABB(target as Layer, shape.rect, wm);
  } else {
    const f = target as Frame;
    localRect = asLocalRect({
      x: shape.rect.x + f.canvas.w / 2,
      y: shape.rect.y + f.canvas.h / 2,
      w: shape.rect.w,
      h: shape.rect.h
    });
  }

  return { ...shape, rect: localRect, __brand: 'local' } as LocalShape;
}

/**
 * unitedShapeOfLayers: Calculates the union bounding box shape of a set of layers in world space (Union Shape of Layers)
 */
export function unitedShapeOfLayers(layers: Layer[]): WorldShape | null {
  if (layers.length === 0) return null;

  const boxes = layers.map(l => getLayerBoundingBox(l));
  const unionBox = getMultiRectUnion(boxes);
  if (!unionBox) return null;

  return {
    type: 'rect' as const,
    rect: unionBox,
    hardEdge: false,
    __brand: 'world'
  } as WorldShape;
}

/**
 * getSmoothSvgPath
 * Converts a shape into a smooth vector SVG path string.
 */
export function getSmoothSvgPath(shape: LocalShape): string {
  const { type, rect } = shape;
  const w = rect.w;
  const h = rect.h;

  if (w <= 0 || h <= 0) return '';

  if (type === 'rect') {
    return `M 0 0 h ${w} v ${h} h ${-w} Z`;
  }

  const rx = w / 2;
  const ry = h / 2;
  const cx = w / 2;
  const cy = h / 2;
  
  // Standard SVG way to draw an ellipse using two arcs
  return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
}

/**
 * getStairedSvgPath
 * Converts a shape into a purely orthogonal, pixel-perfect jagged SVG path string.
 * This mathematically emulates Canvas 50% threshold binary masking.
 */
export function getStairedSvgPath(shape: LocalShape): string {
  const { type, rect } = shape;
  const w = Math.round(rect.w);
  const h = Math.round(rect.h);

  if (w <= 0 || h <= 0) return '';

  if (type === 'rect') {
    return `M 0 0 h ${w} v ${h} h ${-w} Z`;
  }

  // Handle 'circle' (ellipse within bounding box)
  const rows: ({ minX: number; maxX: number } | null)[] = [];

  for (let Y = 0; Y < h; Y++) {
    const cy_offset = Y + 0.5 - h / 2;
    const R = 1 - Math.pow(cy_offset / (h / 2), 2);
    if (R >= 0) {
      const bound = (w / 2) * Math.sqrt(R);
      const minX = Math.ceil(-bound + w / 2 - 0.5);
      const maxX = Math.floor(bound + w / 2 - 0.5);
      if (minX <= maxX) {
        rows.push({ minX, maxX });
      } else {
        rows.push(null);
      }
    } else {
      rows.push(null);
    }
  }

  let path = '';
  let prevMinX = -1;
  let prevMaxX = -1;

  // Trace Left Side (Top to Bottom)
  let firstY = -1;
  for (let Y = 0; Y < h; Y++) {
    const row = rows[Y];
    if (!row) continue;

    if (firstY === -1) {
      firstY = Y;
      path += `M ${row.minX} ${Y} `;
      path += `L ${row.minX} ${Y + 1} `;
    } else {
      if (prevMinX !== row.minX) {
        path += `L ${row.minX} ${Y} `;
      }
      path += `L ${row.minX} ${Y + 1} `;
    }
    prevMinX = row.minX;
  }

  // Trace Right Side (Bottom to Top)
  let lastY = -1;
  for (let Y = h - 1; Y >= 0; Y--) {
    const row = rows[Y];
    if (!row) continue;

    if (lastY === -1) {
      lastY = Y;
      path += `L ${row.maxX + 1} ${lastY + 1} `;
      path += `L ${row.maxX + 1} ${lastY} `;
    } else {
      if (prevMaxX !== row.maxX) {
        path += `L ${row.maxX + 1} ${Y + 1} `;
      }
      path += `L ${row.maxX + 1} ${Y} `;
    }
    prevMaxX = row.maxX;
  }

  if (path) {
    path += 'Z';
  }

  return path;
}
