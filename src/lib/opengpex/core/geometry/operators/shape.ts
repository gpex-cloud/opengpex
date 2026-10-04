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
import { isLayerSource } from './utils';
import { getLayerLocalAABB, getRectIntersection, getLayerBoundingBox, getMultiRectUnion } from './space';
import { snapToPixel } from './snapping';
import { parsePathDataToRings, shapeToPoint2D, ringsToPathData } from './point2d';
import { intersectPathWithPath, differencePathWithPath } from '../poly-clip';

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
 * MASK_AWARE_INTERSECTION — emergency rollback master switch (§5.4).
 *
 *  true  : mask-aware logical intersection (default, correct behavior). The layer's
 *          effective visible shape folds in all enabled vectorMasks before intersecting
 *          with the selection.
 *  false : legacy behavior (intersect only with `layer.visibleShape`, ignoring masks).
 *
 * Read ONLY inside `intersectWithLayer` — never exposed as a function parameter or
 * routed through the GeometryService interface.
 */
const MASK_AWARE_INTERSECTION = true;

/**
 * shapeToPathData — Obtain the pathData for any LocalShape. Path shapes return
 * their pathData directly; rect/circle shapes are first decomposed into rings
 * (via `shapeToPoint2D`) and serialized (via `ringsToPathData`), so they can
 * participate in boolean ops.
 */
function shapeToPathData(shape: LocalShape): string {
  const pd = (shape as { pathData?: string }).pathData;
  if (shape.type === 'path' && pd) return pd;
  return ringsToPathData(shapeToPoint2D(shape));
}

/**
 * getEffectiveVisibleShape: Fold a layer's enabled vectorMasks into its
 * visibleShape, producing the geometry that is actually visible right now.
 *
 * - inverted=false (clip mask) → intersect (∩)
 * - inverted=true  (hole mask) → subtract (−, difference)
 *
 * Feathering is NOT a boolean-topology change (M3 §M3.d.1): a soft edge never moves
 * which pixels are inside the shape, only the alpha falloff at the boundary. So the
 * fold runs on the HARD contours as usual and returns the participating `featherPx`
 * alongside the tight geometry — the caller (`fragmentToNewLayer`) turns that into a
 * padded bbox + a feathered vmask instead of the old whole-layer fallback.
 *
 * Degradation (returns the untouched `visibleShape` with `degraded:true`) only when
 * the geometry genuinely cannot be represented as a crisp polygon + single feather:
 *   - any enabled bitmapMask exists (raster alpha, not geometrizable)
 *   - the participating vectorMasks carry ≥2 DISTINCT positive feathers (a single
 *     folded shape cannot express per-edge softness — §M3.h.2 keeps the whole-layer
 *     / per-submask path for that rare divergent-feather corner; correct, not tight).
 * Disabled masks (enabled=false) are always skipped.
 *
 * Empty result (e.g. base fully carved away by holes) → returns a degenerate
 * empty path shape so `intersectWithLayer` yields null downstream.
 */
export function getEffectiveVisibleShape(
  layer: Layer
): { shape: LocalShape; degraded: boolean; featherPx: number } {
  const base = layer.visibleShape!;
  const vMasks = (layer.vectorMasks ?? []).filter(m => m.enabled);
  const bMasks = (layer.bitmapMasks ?? []).filter(m => m.enabled);

  // Non-geometrizable capability → degrade to the raw visibleShape.
  if (bMasks.length > 0) return { shape: base, degraded: true, featherPx: 0 }; // raster mask
  if (vMasks.length === 0) return { shape: base, degraded: false, featherPx: 0 }; // zero-regression fast path

  // Feather is a per-shape scalar on the folded result. A single value (or a single
  // shared value across masks) can be carried exactly; ≥2 distinct positive feathers
  // cannot be folded into one soft shape, so we degrade to the whole-layer / polygon
  // multi-submask fallback for that corner (§M3.h.2 default, confirmed).
  const positiveFeathers = [...new Set(vMasks.map(m => m.feather).filter(f => f > 0))];
  if (positiveFeathers.length > 1) {
    return { shape: base, degraded: true, featherPx: 0 }; // divergent feather → whole-layer
  }
  const featherPx = positiveFeathers[0] ?? 0;

  // Fold masks into an evolving pathData:
  //   base → pathData; for each mask: intersect (inverted:false) / difference (inverted:true)
  let currentPathData = shapeToPathData(base);
  let currentRect: Rect = base.rect;

  for (const mask of vMasks) {
    const maskPathData = shapeToPathData(mask.shape);
    const res = mask.inverted
      ? differencePathWithPath(currentPathData, maskPathData)  // hole mask → subtract
      : intersectPathWithPath(currentPathData, maskPathData);  // clip mask → intersect

    if (!res) {
      // Empty result (fully carved away or no overlap) → degenerate empty shape.
      return {
        shape: {
          type: 'path',
          rect: asLocalRect({ x: 0, y: 0, w: 0, h: 0 }),
          antiAliased: base.antiAliased,
          pathData: '',
          __brand: 'local',
        } as unknown as LocalShape,
        degraded: false,
        featherPx,
      };
    }

    currentPathData = res.pathData;
    currentRect = res.rect;
  }

  // Snap the folded tight bbox to the enclosing integer pixel grid,
  // matching the existing snap convention (L84-90 / L112-117 below).
  const snappedRect = {
    x: Math.floor(currentRect.x),
    y: Math.floor(currentRect.y),
    w: Math.ceil(currentRect.x + currentRect.w) - Math.floor(currentRect.x),
    h: Math.ceil(currentRect.y + currentRect.h) - Math.floor(currentRect.y),
  };

  return {
    shape: {
      type: 'path',
      rect: asLocalRect(snappedRect),
      antiAliased: base.antiAliased,
      pathData: currentPathData,
      __brand: 'local',
    } as unknown as LocalShape,
    degraded: false,
    featherPx,
  };
}

/**
 * intersectWithLayer: Calculates the intersection of the selection shape with the layer's visible area, returning the intersection shape and center world coordinates
 * (i.e. original LayerService.deriveLogical, now moved to the geometry engine with swapped parameter order)
 */
export function intersectWithLayer(shape: LocalShape, layer: Layer): { visibleShape: LocalShape, center: Point2D, featherPx: number } | null {
  // Mask-aware effective visible shape (§4.3 / §5.1). The flag lets us fall back
  // to the legacy "raw visibleShape" behavior in an emergency (§5.4).
  const eff = MASK_AWARE_INTERSECTION
    ? getEffectiveVisibleShape(layer)
    : { shape: layer.visibleShape!, degraded: false, featherPx: 0 };

  // §5.2: degraded (bitmap mask / divergent feather) → return null so callers fall
  // back to the vectorMask render path (fragmentToNewLayer's else branch).
  if (eff.degraded) return null;

  const layerShape = eff.shape;
  const parentVisibleRect = layerShape.rect;
  const intersection = getRectIntersection(shape.rect, parentVisibleRect);

  if (!intersection) return null;

  const s = snapToPixel(intersection) as Rect;
  const M_orig = getLayerWorldMatrix(layer);

  // Determine effective visibleShape via true geometric intersection.
  //
  // - If either shape is non-rect or has pathData (holes/masks/irregular), compute
  //   the exact geometric intersection via polygon-clipping (Martinez-Rueda-Feito).
  //   This cleanly resolves arbitrary boundaries, multi-ring holes, and concave shapes,
  //   eliminating redundant edges and marching-ant artifacts in Refocus.
  //
  // - If both are simple axis-aligned rectangles without pathData, keep the fast
  //   rect ∩ rect intersection.
  const layerPathData = (layerShape as { pathData?: string }).pathData;
  const selectionPathData = (shape as { pathData?: string }).pathData;

  const isComplex =
    layerShape.type !== 'rect' ||
    shape.type !== 'rect' ||
    Boolean(layerPathData) ||
    Boolean(selectionPathData);

  let visibleShape: LocalShape;
  if (isComplex) {
    const pA = shapeToPathData(layerShape);
    const pB = shapeToPathData(shape);
    const clipped = intersectPathWithPath(pA, pB);
    if (clipped) {
      // Snap the polygon intersection's tight bbox to enclosing integer pixel grid.
      // The pathData provides exact sub-pixel clipping; but the rect must be
      // pixel-aligned so that bounding/cx/cy computations downstream produce
      // integer-aligned positions (avoiding sub-pixel seams between fragments).
      const cr = clipped.rect;
      const snappedRect = {
        x: Math.floor(cr.x),
        y: Math.floor(cr.y),
        w: Math.ceil(cr.x + cr.w) - Math.floor(cr.x),
        h: Math.ceil(cr.y + cr.h) - Math.floor(cr.y),
      };
      visibleShape = {
        type: 'path',
        rect: asLocalRect(snappedRect),
        antiAliased: shape.antiAliased ?? layerShape.antiAliased,
        pathData: clipped.pathData,
        __brand: 'local',
      } as unknown as LocalShape;
    } else {
      // No geometric intersection between the two shapes
      return null;
    }
  } else {
    // Both are simple axis-aligned rectangles
    visibleShape = { ...shape, rect: s } as LocalShape;
  }

  // Compute world center from the actual visibleShape.rect (not from `s`),
  // because for complex intersections the polygon's tight bbox differs from `s`.
  const vr = visibleShape.rect;
  const vCenter = M_orig.apply({ x: vr.x + vr.w / 2, y: vr.y + vr.h / 2 });

  return { visibleShape, center: { x: vCenter.x, y: vCenter.y } as Point2D, featherPx: eff.featherPx };
}



/**
 * translatePathData — Translate (and optionally scale) all absolute coordinates
 * in an SVG path string.
 *
 * Reuses `parsePathDataToRings` (the canonical M/L/Z parser from `point2d.ts`)
 * and rebuilds pathData following the same `M x y L x y ... Z` format as `polygonToShape`.
 *
 * For the Frame path (pure translation): scaleX = scaleY = 1.
 * For the Layer path (affine): applies scale then translate to each (x, y) pair.
 *
 * Formula per point: newX = x * scaleX + dx, newY = y * scaleY + dy.
 */
export function translatePathData(pathData: string, dx: number, dy: number, scaleX = 1, scaleY = 1): string {
  const rings = parsePathDataToRings(pathData);
  if (!rings.length) return pathData;

  const parts: string[] = [];
  for (const ring of rings) {
    if (ring.length < 2) continue;
    const segs: string[] = [];
    for (let i = 0; i < ring.length; i++) {
      const pt = ring[i];
      const nx = pt.x * scaleX + dx;
      const ny = pt.y * scaleY + dy;
      segs.push(`${i === 0 ? 'M' : 'L'} ${nx} ${ny}`);
    }
    segs.push('Z');
    parts.push(segs.join(' '));
  }
  return parts.join(' ');
}

/**
 * scalePathData — Pure scale (no translation) of all absolute coordinates in an
 * SVG path string. Thin semantic wrapper over `translatePathData` for the resize
 * / resample pipeline, where pathData must map from the old src coordinate system
 * to the new one using only `scaleX / scaleY` (see resize spec §4.2 / §4.3).
 *
 * Note: coordinates are only scaled, never snapped — pathData is a sub-pixel
 * precise clipping source and snapping vertices would distort the outline. The
 * enclosing rect carries pixel-grid alignment instead (spec §5).
 */
export function scalePathData(pathData: string, scaleX: number, scaleY: number): string {
  return translatePathData(pathData, 0, 0, scaleX, scaleY);
}

/**
 * Project shape from local to world space
 */
export function localToWorldShape(shape: Shape, source: Layer | Frame): WorldShape {
  if ('__brand' in shape && shape.__brand === 'world') return shape as WorldShape;

  let worldRect;
  let worldPathData: string | undefined = (shape as { pathData?: string }).pathData;

  if (isLayerSource(source)) {
    const wm = getLayerWorldMatrix(source as Layer);
    const x = (shape.rect.x * wm.a) + (shape.rect.y * wm.c) + wm.tx;
    const y = (shape.rect.x * wm.b) + (shape.rect.y * wm.d) + wm.ty;
    worldRect = asWorldRect({ x, y, w: shape.rect.w * wm.a, h: shape.rect.h * wm.d });

    // For path shapes, transform pathData coordinates using the layer's world matrix
    if (shape.type === 'path' && worldPathData) {
      worldPathData = translatePathData(worldPathData, wm.tx, wm.ty, wm.a, wm.d);
    }
  } else {
    const f = source as Frame;
    const dx = -f.canvas.w / 2;
    const dy = -f.canvas.h / 2;
    worldRect = asWorldRect({
      x: shape.rect.x + dx,
      y: shape.rect.y + dy,
      w: shape.rect.w,
      h: shape.rect.h
    });

    // For path shapes, translate pathData coordinates by the same offset
    if (shape.type === 'path' && worldPathData) {
      worldPathData = translatePathData(worldPathData, dx, dy);
    }
  }

  const result = { ...shape, rect: worldRect, __brand: 'world' } as WorldShape;
  if (worldPathData !== undefined) {
    (result as unknown as { pathData: string }).pathData = worldPathData;
  }
  return result;
}

/**
 * Project world shape to local space
 */
export function worldToLocalShape(shape: WorldShape, target: Layer | Frame): LocalShape {
  let localRect;
  let localPathData: string | undefined = (shape as { pathData?: string }).pathData;

  if (isLayerSource(target)) {
    const wm = getLayerWorldMatrix(target as Layer);
    localRect = getLayerLocalAABB(target as Layer, shape.rect, wm);

    // For path shapes, apply inverse scale + translate to pathData coordinates.
    // Inverse of (x * scaleX + tx, y * scaleY + ty) = ((x - tx) / scaleX, (y - ty) / scaleY)
    if (shape.type === 'path' && localPathData && wm.a !== 0 && wm.d !== 0) {
      localPathData = translatePathData(localPathData, -wm.tx / wm.a, -wm.ty / wm.d, 1 / wm.a, 1 / wm.d);
    }
  } else {
    const f = target as Frame;
    const dx = f.canvas.w / 2;
    const dy = f.canvas.h / 2;
    localRect = asLocalRect({
      x: shape.rect.x + dx,
      y: shape.rect.y + dy,
      w: shape.rect.w,
      h: shape.rect.h
    });

    // For path shapes, translate pathData coordinates back to frame-local
    if (shape.type === 'path' && localPathData) {
      localPathData = translatePathData(localPathData, dx, dy);
    }
  }

  const result = { ...shape, rect: localRect, __brand: 'local' } as LocalShape;
  if (localPathData !== undefined) {
    (result as unknown as { pathData: string }).pathData = localPathData;
  }
  return result;
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

// Re-export from canonical source (point2d.ts) for backward compatibility
export { shapeToPoint2D } from './point2d';
