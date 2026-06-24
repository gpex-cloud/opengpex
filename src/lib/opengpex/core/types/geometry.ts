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

import { Layer, Frame, CameraState, NormalizedState } from './models';
export * from './primitives';
import {
  Point2D, Dimensions, Rect, IMatrix3x3, IMatrix3x3Constructor,
  WorldPoint, WorldRect, LocalPoint, LocalRect, ViewportPoint, ViewportRect,
  WorldShape, LocalShape, Shape,
  LocalPolygon, WorldPolygon
} from './primitives';

/** 
 * LayerPoseOverride: Layer pose override parameters
 */
export interface LayerPoseOverride {
  cx?: number;
  cy?: number;
  rotation?: number;
}

/** 
 * DecomposedMatrix: Semantic pose parameters after matrix decomposition
 */
export interface DecomposedMatrix {
  rotation: number;
  flip: { h: boolean; v: boolean };
  scaleX: number;
  scaleY: number;
}

/** 
 * SmartGuideData: Smart guide line alignment data
 */
export interface SmartGuideData {
  x?: number;
  y?: number;
  isBirthX?: boolean;
  isBirthY?: boolean;
}

/**
 * CameraCenterOptions: Camera centering options
 */
export interface CameraCenterOptions {
  padding?: number;
  fixedScale?: number;
  maxScale?: number;
  offsetTop?: number;
  offsetBottom?: number;
  offsetLeft?: number;
  offsetRight?: number;
}

/**
 * GeometryService: Service contract exposed by the editor geometry engine
 */
export interface GeometryService {
  /** Matrix constructor contract for convenient direct calls by plugins */
  readonly Matrix: IMatrix3x3Constructor;

  // --- Spatial Coordinates ---

  /** Coordinate system and space transformations */
  space: {
    /** Viewport physical coordinates -> World absolute coordinates */
    screenToWorld: (vx: number, vy: number, frame: Frame, camera?: CameraState) => WorldPoint;
    /** World absolute coordinates -> Viewport physical coordinates */
    worldToScreen: (wx: number, wy: number, frame: Frame, camera?: CameraState) => ViewportPoint;
    /** World absolute coordinates -> Local relative coordinates */
    worldToLocal: (wx: number, wy: number, frame: Frame) => LocalPoint;
    /** Local relative coordinates -> World absolute coordinates */
    localToWorld: (px: number, py: number, frame: Frame) => WorldPoint;
    /** Local relative rect -> World absolute rect */
    localToWorldRect: (rect: Rect, frame: Frame) => WorldRect;
    /** World absolute rect -> Local relative rect */
    worldToLocalRect: (rect: WorldRect, frame: Frame) => LocalRect;
    /** Viewport physical coordinates -> Local relative coordinates */
    screenToLocal: (vx: number, vy: number, frame: Frame, camera?: CameraState) => LocalPoint;
    /** Local relative coordinates -> Viewport physical coordinates */
    localToScreen: (px: number, py: number, frame: Frame, camera?: CameraState) => ViewportPoint;
    /** Local rect -> Viewport physical rect */
    localToScreenRect: (rect: Rect, frame: Frame, camera?: CameraState) => ViewportRect;
    /** World rect -> Viewport physical rect */
    worldToScreenRect: (rect: WorldRect, frame: Frame, camera?: CameraState) => ViewportRect;

    /** Calculates the projection AABB of selection in layer local space */
    getLayerLocalAABB: (layer: Layer, worldRect: WorldRect, extraOverride?: LayerPoseOverride) => LocalRect;
    /** Calculates the resized rect */
    calculateResizedRect: (curPoint: WorldPoint, anchor: WorldPoint, aspect?: number, dragType?: string, startDim?: Dimensions) => WorldRect;
    /** Aspect-ratio aware boundary clipping */
    clampRectWithAspect: (rect: Rect, bounds: Dimensions, anchor: WorldPoint, aspect?: number) => Rect;
    /** Constraints point within rect bounds */
    clampPointToRect: (p: Point2D, rect: Dimensions) => { x: number, y: number, dx: number, dy: number };
    /** Balances translation vector according to ratio */
    balanceVectorByAspect: (v: Point2D, aspect: number, direction: Point2D) => Point2D;
    /** Gets layer world bounding box */
    getLayerBoundingBox: (l: Layer, extraOverride?: IMatrix3x3) => WorldRect;
    /** Calculates center point of a rect */
    getRectCenter: (rect: Rect) => Point2D;
    /** Calculates intersection of two rects */
    getRectIntersection: <T extends Rect>(r1: T, r2: T, minSize?: number) => T | null;
    /** Calculates union of two rects */
    getRectUnion: <T extends Rect>(r1: T, r2: T) => T;
    /** Calculates union of multiple rects */
    getMultiRectUnion: <T extends Rect>(rects: T[]) => T | null;
    /** Calculates four patch rects around a hole */
    getSurroundingRects: <T extends Rect>(outer: T, hole: T) => { top: T, bottom: T, left: T, right: T };
    /** Constrains rect, maintaining minimum overlap */
    clampRectWithOverlap: <T extends Rect>(rect: T, bounds: Dimensions, minOverlap?: number) => T;

    /** Determines if rect contains point */
    isPointInRect: (p: Point2D, r: Rect) => boolean;
    /** Determines if shape contains point */
    isPointInShape: (p: Point2D, shape: Shape) => boolean;
    /** Hit test: determines if a world coordinate point hits the specified layer */
    testLayerHit: (pos: WorldPoint, layer: Layer) => boolean;
    /** Deep pick: gets all layers under the specified position (from top to bottom) */
    pickLayersAt: (pos: WorldPoint, layers: NormalizedState<Layer>) => Layer[];
    /** Top-level pick: gets the topmost layer under the specified position */
    pickTopLayer: (pos: WorldPoint, layers: NormalizedState<Layer>) => Layer | null;
  };

  /** Gets the current zoom scale (k) */
  getScale: (frame: Frame, camera?: CameraState) => number;
  /** Explicitly cast to WorldRect */
  asWorldRect: (r: Rect) => WorldRect;
  /** Explicitly cast to LocalRect */
  asLocalRect: (r: Rect) => LocalRect;
  // --- Smart Geometry Engine ---

  /** Geometry transformation service */
  transform: {
    /** Gets layer world transformation matrix */
    getLayerWorldMatrix: (layer: Layer, extraOverride?: LayerPoseOverride) => IMatrix3x3;
    /** Gets layer local transformation matrix */
    getLayerLocalMatrix: (layer: Layer, frame: Frame, extraOverride?: LayerPoseOverride) => IMatrix3x3;
    /** Gets layer center world coordinates */
    getLayerCenter: (layer: Layer) => WorldPoint;
    /** Decomposes matrix: extracts pose parameters like rotation, scale, flip */
    decomposeMatrix: (matrix: IMatrix3x3, refRotation?: number) => DecomposedMatrix;
    /** Executes artboard-level geometry transformation (rotate/flip) */
    transformFrame: (frame: Frame, operation: 'rotate_r' | 'rotate_l' | 'flip_h' | 'flip_v') => Frame;
  };

  /** Camera service */
  camera: {
    /** Calculates camera centered pose */
    getFitCamera: (viewport: Dimensions, content: Dimensions, options?: CameraCenterOptions) => CameraState;
    /** Calculates zoom centered at point */
    projectZoom: (current: CameraState, zoomDelta: number, anchor: ViewportPoint, limits?: { min: number; max: number }) => CameraState;
    /** Calculates translation */
    projectPan: (current: CameraState, delta: Point2D) => CameraState;
    /** Gets viewport projection matrix */
    getCameraMatrix: (frame: Frame, camera?: CameraState) => IMatrix3x3;
    /** Calculates viewport bounding rect in world space */
    getViewportWorldRect: (viewportDim: Dimensions, camera: CameraState, canvas: Dimensions, padding?: number) => WorldRect;
  };

  /** Geometry snapping service */
  snapping: {
    /** Rect alignment snapping */
    snapRect: (rect: Rect, frame: Frame, options?: { clamp?: boolean, threshold?: number, excludeLayerId?: string }) => { x: number, y: number, smartguides: SmartGuideData | null };
    /** Physical pixel snapping */
    snapToPixel: <T extends Rect | Point2D>(r: T, strategy?: 'round' | 'floor' | 'ceil') => T;
    /** Grid snapping */
    snapPoint: (pos: Point2D) => Point2D;
    /** Aligns a rect in world space to canvas local physical pixel grid */
    snapRectToPixel: (
      targetRect: WorldRect,
      canvasDim: Dimensions,
      strategy?: 'round' | 'floor' | 'ceil'
    ) => WorldRect;
  };



  /** Shape and space transformation service */
  shape: {
    /** Generates smooth vector SVG outline path */
    getSmoothSvgPath: (shape: LocalShape) => string;
    /** Generates jagged (aliased) pure right-angled outline path for shapes */
    getStairedSvgPath: (shape: LocalShape) => string;
    /** Projects artboard selection to layer local space (used for clipping/peeling) */
    frameLocalToLayerLocal: (shape: Shape, frame: Frame, layer: Layer) => LocalShape;
    /** Calculates intersection of selection shape and layer visible area */
    intersectWithLayer: (shape: LocalShape, layer: Layer) => { visibleShape: LocalShape, center: Point2D } | null;
    /** Converts local coordinate shape to world coordinate shape (atomic tool) */
    localToWorldShape: (shape: Shape, source: Layer | Frame) => WorldShape;
    /** Converts world coordinate shape to local coordinate shape (atomic tool) */
    worldToLocalShape: (shape: WorldShape, target: Layer | Frame) => LocalShape;
    /** Projects layer local shape to artboard space (used for rendering highlight/bounding-box) */
    layerLocalToFrameLocal: (shape: Shape, layer: Layer, frame: Frame) => LocalShape;
    /** Calculates joint bounding box shape of a set of layers in world space */
    unitedShapeOfLayers: (layers: Layer[]) => WorldShape | null;
  };

  /**
   * Polygon engine service: independent multi-ring vector polygon utilities for irregular selection.
   * Parallel to `shape.*` and intentionally kept separate (see phase1_irregular_clip_spec §2.0).
   */
  polygon: {
    /** Computes axis-aligned bounding box of a multi-ring point set (no brand). */
    computePolygonBounds: (rings: Point2D[][]) => Rect;
    /** Projects polygon from local space to world space (Layer or Frame source). */
    localToWorldPolygon: (poly: LocalPolygon, source: Layer | Frame) => WorldPolygon;
    /** Projects polygon from world space to local space (Layer or Frame target). */
    worldToLocalPolygon: (poly: WorldPolygon, target: Layer | Frame) => LocalPolygon;
    /** Composes frame-local -> world -> layer-local polygon projection. */
    frameLocalToLayerLocalPolygon: (poly: LocalPolygon, frame: Frame, layer: Layer) => LocalPolygon;
    /** Inverse: layer-local -> world -> frame-local polygon projection. */
    layerLocalToFrameLocalPolygon: (poly: LocalPolygon, layer: Layer, frame: Frame) => LocalPolygon;
    /**
     * Generates a multi-ring SVG path `d` string (relative to `poly.bounds.x/y`),
     * suitable for evenodd fill rule rendering.
     */
    polygonToSvgPathD: (poly: LocalPolygon) => string;
  };
}
