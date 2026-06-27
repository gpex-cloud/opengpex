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

import { Matrix3x3 } from './matrix';
import {
  screenToWorld, worldToScreen, worldToLocal, localToWorld, screenToLocal, localToScreen,
  localToWorldRect, worldToLocalRect, getLayerLocalAABB,
  calculateResizedRect, clampRectWithAspect, clampPointToRect, balanceVectorByAspect,
  clampRectWithOverlap, getLayerBoundingBox, getRectIntersection, getSurroundingRects,
  isPointInRect, isPointInShape, testLayerHit, pickLayersAt, pickTopLayer,
  getRectUnion, getMultiRectUnion, getRectCenter
} from './operators/space';
import {
  asWorldRect, asLocalRect, asWorldPoint, asViewportRect,
  GeometryService, Frame, Layer, WorldRect, IMatrix3x3, LayerPoseOverride,
  CameraState, Rect, Point2D, Dimensions, WorldPoint,
  ViewportPoint, CameraCenterOptions, WorldShape, LocalShape, Shape, NormalizedState,
  LocalPolygon, WorldPolygon
} from '@opengpex/editor/core/types';
import {
  frameLocalToLayerLocal, layerLocalToFrameLocal, intersectWithLayer, getStairedSvgPath, getSmoothSvgPath,
  localToWorldShape, worldToLocalShape, unitedShapeOfLayers
} from './operators/shape';
import {
  computePolygonBounds, localToWorldPolygon, worldToLocalPolygon,
  frameLocalToLayerLocal as polyFrameToLayer, layerLocalToFrameLocal as polyLayerToFrame, polygonToSvgPathD,
  isPointInPolygon, computeRingArea, simplifyOpen, simplifyRing
} from './operators/polygon';
import { snapRect, snapToPixel, snapRectToPixel } from './operators/snapping';
import {
  decomposeMatrix,
  getLayerWorldMatrix,
  getLayerLocalMatrix,
  transformFrame
} from './operators/transform';
import {
  getFitCamera,
  projectZoom,
  projectPan,
  getCameraMatrix,
  getViewportWorldRect
} from './operators/camera';

export function createGeometryService(): GeometryService {
  return {
    Matrix: Matrix3x3,
    space: {
      screenToWorld: (vx: number, vy: number, frame: Frame, camera?: CameraState) => screenToWorld(vx, vy, camera || frame.camera, frame.canvas),
      worldToScreen: (wx: number, wy: number, frame: Frame, camera?: CameraState) => worldToScreen(wx, wy, camera || frame.camera, frame.canvas),
      worldToLocal: (wx: number, wy: number, frame: Frame) => worldToLocal(wx, wy, frame.canvas),
      localToWorld: (px: number, py: number, frame: Frame) => localToWorld(px, py, frame.canvas),
      localToWorldRect: (rect: Rect, frame: Frame) => localToWorldRect(rect, frame.canvas),
      worldToLocalRect: (rect: WorldRect, frame: Frame) => worldToLocalRect(rect, frame.canvas),
      screenToLocal: (vx: number, vy: number, frame: Frame, camera?: CameraState) => screenToLocal(vx, vy, camera || frame.camera),
      localToScreen: (px: number, py: number, frame: Frame, camera?: CameraState) => localToScreen(px, py, camera || frame.camera),
      localToScreenRect: (rect: Rect, frame: Frame, camera?: CameraState) => {
        const cam = camera || frame.camera;
        const { x, y } = localToScreen(rect.x, rect.y, cam);
        const k = cam.k;
        return asViewportRect({ x, y, w: rect.w * k, h: rect.h * k });
      },
      worldToScreenRect: (rect: WorldRect, frame: Frame, camera?: CameraState) => {
        const cam = camera || frame.camera;
        const { x, y } = worldToScreen(rect.x, rect.y, cam, frame.canvas);
        const k = cam.k;
        return asViewportRect({ x, y, w: rect.w * k, h: rect.h * k });
      },
      getLayerLocalAABB: (l: Layer, wr: WorldRect, extra?: LayerPoseOverride) => {
        const wm = getLayerWorldMatrix(l, extra);
        return getLayerLocalAABB(l, wr, wm);
      },
      calculateResizedRect: (p: WorldPoint, a: WorldPoint, asp?: number, t?: string, sd?: Dimensions) => calculateResizedRect(p, a, asp, t, sd),
      clampRectWithAspect: (r: Rect, b: Dimensions, a: WorldPoint, asp?: number) => clampRectWithAspect(r, b, a, asp),
      clampPointToRect: (p: Point2D, r: Dimensions) => clampPointToRect(p, r),
      balanceVectorByAspect: (v: Point2D, a: number, d: Point2D) => balanceVectorByAspect(v, a, d),
      getRectIntersection: <T extends Rect>(r1: T, r2: T, minSize?: number) => getRectIntersection(r1, r2, minSize),
      getRectCenter: (rect: Rect) => getRectCenter(rect),
      getRectUnion: <T extends Rect>(r1: T, r2: T) => getRectUnion(r1, r2),
      getMultiRectUnion: <T extends Rect>(rects: T[]) => getMultiRectUnion(rects),
      getSurroundingRects: <T extends Rect>(outer: T, hole: T) => getSurroundingRects(outer, hole),
      clampRectWithOverlap: <T extends Rect>(r: T, b: Dimensions, m?: number) => clampRectWithOverlap(r, b, m),
      getLayerBoundingBox: (l: Layer, extra?: IMatrix3x3) => {
        const wm = extra || getLayerWorldMatrix(l);
        return getLayerBoundingBox(l, wm);
      },
      // Point Hit Tests
      isPointInRect: (p: Point2D, r: Rect) => isPointInRect(p, r),
      isPointInShape: (p: Point2D, s: Shape) => isPointInShape(p, s),
      testLayerHit: (pos: WorldPoint, layer: Layer) => testLayerHit(pos, layer),
      pickLayersAt: (pos: WorldPoint, layers: NormalizedState<Layer>) => pickLayersAt(pos, layers),
      pickTopLayer: (pos: WorldPoint, layers: NormalizedState<Layer>) => pickTopLayer(pos, layers),
    },
    transform: {
      getLayerWorldMatrix: (l: Layer, extra?: LayerPoseOverride) => getLayerWorldMatrix(l, extra),
      getLayerLocalMatrix: (l: Layer, f: Frame, extra?: LayerPoseOverride) => getLayerLocalMatrix(l, f.canvas, extra),
      getLayerCenter: (l: Layer) => {
        const wm = getLayerWorldMatrix(l);
        return asWorldPoint({ x: wm.tx, y: wm.ty });
      },
      decomposeMatrix: (matrix: IMatrix3x3, refRotation?: number) => decomposeMatrix(matrix, refRotation),
      transformFrame: (frame: Frame, operation: 'rotate_r' | 'rotate_l' | 'flip_h' | 'flip_v') => transformFrame(frame, operation),
    },
    camera: {
      getFitCamera: (viewport: Dimensions, content: Dimensions, options?: CameraCenterOptions) => getFitCamera(viewport, content, options),
      projectZoom: (current: CameraState, zoomDelta: number, anchor: ViewportPoint, limits?: { min: number; max: number }) => projectZoom(current, zoomDelta, anchor, limits),
      projectPan: (current: CameraState, delta: Point2D) => projectPan(current, delta),
      getCameraMatrix: (frame: Frame, camera?: CameraState) => getCameraMatrix(camera || frame.camera, frame.canvas),
      getViewportWorldRect: (viewportDim: Dimensions, camera: CameraState, canvas: Dimensions, padding = 0) => getViewportWorldRect(viewportDim, camera, canvas, padding),
    },
    snapping: {
      snapToPixel: <T extends Rect | Point2D>(r: T, strategy?: 'round' | 'floor' | 'ceil') => snapToPixel(r as Rect & Point2D, strategy) as T,
      snapPoint: (pos: Point2D) => snapToPixel(pos),
      snapRect: (rect: Rect, frame: Frame, options?: { clamp?: boolean; threshold?: number; excludeLayerId?: string }) => snapRect(rect, frame, options),
      snapRectToPixel: (
        targetRect: WorldRect,
        canvasDim: Dimensions,
        strategy?: 'round' | 'floor' | 'ceil'
      ) => snapRectToPixel(targetRect, canvasDim, strategy),
    },
    shape: {
      getSmoothSvgPath: (shape: LocalShape) => getSmoothSvgPath(shape),
      getStairedSvgPath: (shape: LocalShape) => getStairedSvgPath(shape),
      frameLocalToLayerLocal: (shape: Shape, frame: Frame, layer: Layer) => frameLocalToLayerLocal(shape, frame, layer),
      intersectWithLayer: (shape: LocalShape, layer: Layer) => intersectWithLayer(shape, layer),
      localToWorldShape: (shape: Shape, source: Layer | Frame) => localToWorldShape(shape, source),
      worldToLocalShape: (shape: WorldShape, target: Layer | Frame) => worldToLocalShape(shape, target),
      layerLocalToFrameLocal: (shape: Shape, layer: Layer, frame: Frame) => layerLocalToFrameLocal(shape, layer, frame),
      unitedShapeOfLayers: (layers: Layer[]) => unitedShapeOfLayers(layers),
    },
    polygon: {
      computePolygonBounds: (rings: Point2D[][]) => computePolygonBounds(rings),
      localToWorldPolygon: (poly: LocalPolygon, source: Layer | Frame) => localToWorldPolygon(poly, source),
      worldToLocalPolygon: (poly: WorldPolygon, target: Layer | Frame) => worldToLocalPolygon(poly, target),
      frameLocalToLayerLocal: (poly: LocalPolygon, frame: Frame, layer: Layer) => polyFrameToLayer(poly, frame, layer),
      layerLocalToFrameLocal: (poly: LocalPolygon, layer: Layer, frame: Frame) => polyLayerToFrame(poly, layer, frame),
      polygonToSvgPathD: (poly: LocalPolygon) => polygonToSvgPathD(poly),
      isPointInPolygon: (point: Point2D, rings: Point2D[][]) => isPointInPolygon(point, rings),
      computeRingArea: (ring: Point2D[]) => computeRingArea(ring),
      simplifyOpen: (points: Point2D[], epsilon: number) => simplifyOpen(points, epsilon),
      simplifyRing: (ring: Point2D[], epsilon: number) => simplifyRing(ring, epsilon),
    },
    getScale: (frame: Frame, camera?: CameraState) => (camera || frame.camera).k,
    asWorldRect: (r: Rect) => asWorldRect(r),
    asLocalRect: (r: Rect) => asLocalRect(r),
  };
}
