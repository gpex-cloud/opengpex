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

import { Layer, Frame, CameraState, NormalizedState, CubicSegment, PenAnchor, PenPathData } from './models';
export * from './primitives';
import {
  Point2D, Dimensions, Rect, IMatrix3x3, IMatrix3x3Constructor,
  WorldPoint, WorldRect, LocalPoint, LocalRect, ViewportPoint, ViewportRect,
  WorldShape, LocalShape, Shape,
  LocalPolygon, WorldPolygon, PolygonFlags
} from './primitives';

/**
 * A polygon's content box measured ALONG a caller-supplied orientation
 * (see `computeRotationBox` — a pure measurement, not a rotation).
 * All values are in the polygon's own coordinate units; HUD consumers map
 * them to the screen with the usual space conversions.
 */
export interface RotationBox {
  /** Orientation in radians the box was measured along (echoed back). */
  angleRad: number;
  /** Center of the projected bounding box, polygon-local coordinates. */
  cx: number;
  cy: number;
  /** Extent along the rotated x-axis. */
  w: number;
  /** Extent along the rotated y-axis (perpendicular, y-down handed). */
  h: number;
}

/**
 * The screen-space counterpart of `RotationBox`: the entity's true box in
 * SCREEN pixels — the top-left CORNER (not the center), extents already
 * scaled by the camera, and the orientation as actually rendered (camera
 * rotation folded in). This is the HUD framework's single geometry
 * contract: `toScreenRotationBox` performs the local→screen conversion;
 * the framework never derives it from entity internals itself.
 */
export interface ScreenRotationBox {
  /** Screen-space position of the box's top-left corner. */
  x: number;
  y: number;
  /** Screen-px extents along the entity's own rotated axes. */
  w: number;
  h: number;
  /** Raw orientation in radians (screen space, y-down handedness). */
  angleRad: number;
}

/**
 * Scale-handle vocabulary of the fragment scale gesture: four corners
 * (both axes scale, opposite corner anchored) and four edges (single axis
 * scales, opposite edge line pinned).
 */
export type FragmentScaleHandle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';

/**
 * TransformParams: THE base pose-vocabulary of the editor — a PARTIAL pose
 * patch over the four pose slots a layer-level transform can address
 * (anchor cx/cy, rotation, gesture-time scale). Every slot is optional:
 * consumers fill only the slots they mean, and resolvers fill the rest
 * from live layer state. Slot names mirror `FragmentPose`'s pose slots
 * one-to-one; an absent slot means "not touched" and is resolved by the
 * consumer (gesture merge / bake command). `scale`/`scaleY` carry a
 * GESTURE-TIME magnification only — they exist nowhere on `Layer` (whose
 * `scale` stays deprecated and constantly 1.0) and are baked into pixels
 * by whoever commits the gesture.
 */
export interface TransformParams {
  /** Bounding-box anchor (world coords). */
  cx?: number;
  cy?: number;
  /** Degrees; sign convention follows `getOrientationMatrix`. */
  rotation?: number;
  /** Gesture-time magnification; defaults to 1 (and scaleY to scale). */
  scale?: number;
  scaleY?: number;
  /**
   * sourceAngle: the angle the CONTENT sits at inside the bitmap itself —
   * the peel bake moves the orientation into pixels and zeroes the field,
   * so a scale gesture solved along the content's own axes must cancel that
   * tilt BEFORE stretching. The pose's linear part composes
   * `O(rotation) · S · R(−sourceAngle)`; absent (= 0, every non-peel
   * consumer) the matrix is bitwise the historical `O · S`.
   */
  sourceAngle?: number;
}

/**
 * FragmentPose: the COMPLETE pose of a fragment layer at one instant —
 * the frozen gesture-start snapshot every gesture operator recomputes
 * from (`fragmentPoseFromLayer` produces it; nothing mutates it
 * mid-gesture). Unlike the `TransformParams` patch, every slot is
 * concrete: an absent value is meaningless here. `visibleOffset`/
 * `bounding` carry the content-crop semantics (the CONTENT box, not the
 * bounding anchor, is what every anchor/center/ROI is expressed on).
 */
export interface FragmentPose {
  /** Bounding-box anchor (world coords). */
  cx: number;
  cy: number;
  /** Degrees; sign convention follows `getOrientationMatrix`. */
  rotation: number;
  flip: { h: boolean; v: boolean };
  /** Content (crop) dimensions — for an exchange, equal to `bounding`. */
  bounding: { w: number; h: number };
  /** Content offset inside the bounding box = visibleShape.rect.x/y. */
  visibleOffset: Point2D;
  /** Current magnification (1 outside a transform gesture). */
  scale: number;
  scaleY: number;
  /**
   * sourceAngle — the content's tilt inside the bitmap (see
   * `TransformParams.sourceAngle`). Absent (= 0) for poses built from
   * layer fields (`fragmentPoseFromLayer`); set live by the
   * selection-driven scale gesture.
   */
  sourceAngle?: number;
}

/**
 * LayerPoseOverride: Layer pose override parameters — TransformParams used
 * as a RENDERING seam: `computeWorldMatrix` (and the GPU preview path)
 * applies the supplied slots on top of the layer's committed pose. The
 * override exists only on live channels (volatile gesture state, explicit
 * bake requests) — never in committed documents. `scaleY` defaults to
 * `scale` when omitted (uniform magnification).
 */
export type LayerPoseOverride = TransformParams;

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
 * LayerMovePose: Pre-computed rotation-aware pose information for layer move operations.
 * Computed once at drag start and reused throughout the move (rotation/flip are constant during move).
 */
export interface LayerMovePose {
  /** World-space fixed offset between visible content center and (cx, cy) = O × visibleOffset */
  centerOffset: Point2D;
  /** AABB size after rotation (world-space axis-aligned bounding box dimensions) */
  aabbSize: Dimensions;
  /** Original visibleOffset in local space */
  visibleOffset: Point2D;
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
    /**
     * Object-LOCAL-axes rect centre -> World centre (cx, cy).
     * Inverse of the pose half of `computeWorldMatrix`, for the orientation-aware
     * resize path. Shares the O = R × F convention with the renderer.
     */
    localToWorldCenter: (
      startCenter: { cx: number, cy: number },
      startLocalRect: Rect,
      nextLocalRect: Rect,
      orientation: { rotation: number, flip?: { h: boolean, v: boolean } }
    ) => Point2D;
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
    /**
     * Whether a layer's own axes diverge from the canvas axes (non-zero rotation
     * or any mirror flag). THE single source of truth for "does this need
     * local-axes math?" — the framework's resize dispatch and the marker/text
     * resize handlers all defer to this so they can never disagree.
     */
    isRotatedPose: (layer: Pick<Layer, 'rotation' | 'flip'>) => boolean;
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
    /** Computes correct (cx, cy) world anchor for a fragment layer accounting for orientation */
    computeFragmentCenter: (worldCenter: Point2D, visibleOffset: Point2D, rotation: number, flip: { h: boolean; v: boolean }) => Point2D;
    /** Computes rotation-aware pose info (AABB size, center offset) for layer move operations */
    computeLayerMovePose: (layer: Layer) => LayerMovePose;
    /** Normalise an angle into the half-open range [0, 360). */
    normalizeAngle: (deg: number) => number;
    /** Snap an angle to the nearest multiple of `step` degrees. */
    snapAngle: (deg: number, step: number) => number;
    /**
     * Screen-space angle of a LOCAL direction angle under the layer's pose
     * (flip mirrored first, then rotation added). Math only — mapping the
     * result to direction-keyed vocabulary (resize cursors) is the caller's.
     */
    poseScreenAngle: (angleDeg: number, rotationDeg: number, flip?: { h: boolean; v: boolean }) => number;
    /** Snaps a rotation delta (radians) so `base + delta` lands on the stepDeg grid (default 15°). */
    snapRotationRad: (deltaRad: number, baseRad: number, stepDeg?: number) => number;
    /**
     * Fragment free-transform pose math (peel exchange corner-scale /
     * rotation). Operates on the CONTENT box (the visibleShape crop
     * displaced by (vx, vy) inside the bounding box) in world coordinates —
     * see `core/geometry/operators/fragment.ts` for the geometry model.
     * Exposed on the service so plugins can drive the transform gesture
     * without importing internal operators.
     */
    fragmentPoseFromLayer: (layer: {
      cx: number;
      cy: number;
      rotation: number;
      flip: { h: boolean; v: boolean };
      bounding: { w: number; h: number };
      visibleShape?: { rect?: { x: number; y: number; w?: number; h?: number } } | null;
    }) => FragmentPose;
    fragmentContentCenter: (params: FragmentPose) => Point2D;
    /**
     * Pose-derived bake ROI: the transformed content box's world AABB,
     * padded and snapped outward to whole pixels. The DEGENERATE-session
     * fallback for the selection-first bake ROI (a peel without a
     * selection has no pristine geometry to derive the ROI from).
     */
    fragmentBakeRoi: (params: FragmentPose, pad?: number) => { x: number; y: number; w: number; h: number };
    computeFragmentRotation: (
      start: FragmentPose,
      pointerWorld: Point2D,
      startRotationDeg: number,
      startPointerAngleRad: number,
      opts?: { shift?: boolean; absoluteBaseDeg?: number },
    ) => TransformParams;
    /**
     * Carries the selection polygon by the same map that moved the peeled
     * fragment's content box from `start` to `end` (rotation, scaling along
     * the fragment's own axes and mirroring included).
     */
    followFragmentSelection: (
      selection: LocalPolygon,
      start: FragmentPose,
      end: FragmentPose,
      frame: Frame,
    ) => LocalPolygon;
    /**
     * Content box of the polygon measured along `angleRad`. The angle is
     * NEVER guessed from the vertices — it is the caller's state: a peel
     * session passes the fragment's true pose, a plain selection passes 0
     * (degenerating to the historical upright AABB exactly).
     */
    rotatedPolygonBox: (poly: LocalPolygon, angleRad?: number) => RotationBox;
    /** Screen-space conversion for the HUD anchor contract. */
    toScreenRotationBox: (box: RotationBox, cam: CameraState) => ScreenRotationBox;
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
    /**
     * Viewport → visible frame-local rect: camera-mapped, margin-padded,
     * block-quantized, with a stable `key` (cache identity across pans).
     * Viewport-culling infrastructure — consumers own the "outside the rect"
     * semantics.
     */
    getVisibleRect: (viewportDim: Dimensions, camera: CameraState, options?: {
      margin?: 'halfDiagonal' | number;
      blockSizeCssPx?: number;
    }) => { rect: LocalRect; key: string } | null;
    /**
     * One-stop visible window for pixel-aligned derivations (the ants
     * staircase): `getVisibleRect` + the frame-local rect → target-layer
     * grid-cell conversion in a single call. `gridOffset` is the target
     * layer's grid phase (0/.5). `{ window: undefined, key: 'full' }` for a
     * degenerate camera/viewport (caller falls back to uncapped derivation).
     */
    visibleGridWindow: (
      viewportDim: Dimensions,
      camera: CameraState,
      gridOffset: { readonly x: number; readonly y: number },
      options?: {
        margin?: 'halfDiagonal' | number;
        blockSizeCssPx?: number;
      }
    ) => {
      window?: { readonly k0: number; readonly r0: number; readonly k1: number; readonly r1: number };
      key: string;
    };
    /**
     * Snaps a frame-local coordinate's fraction onto the grid-offset domain
     * {0, 0.5} (the target layer's document-pixel-grid phase).
     */
    quantizeGridOffset: (v: number) => 0 | 0.5;
  };

  /** Geometry snapping service */
  snapping: {
    /** Rect alignment snapping */
    snapRect: (rect: Rect, frame: Frame, options?: { clamp?: boolean, threshold?: number, excludeLayerId?: string, snapToCanvas?: boolean, snapToBirth?: boolean, snapToLayers?: boolean, excludeLayerTypes?: string[], ignoreLockedLayers?: boolean, ignoreSmallLayers?: boolean, smallLayerThreshold?: number, maxSnapTargets?: number }) => { x: number, y: number, smartguides: SmartGuideData | null };
    /** Edge-level snapping for resize operations */
    snapEdge: (rect: Rect, handle: string, frame: Frame, options?: { threshold?: number, snapToCanvas?: boolean, snapToLayers?: boolean, maxSnapTargets?: number }) => { rect: Rect, smartguides: SmartGuideData | null };
    /**
     * Rotation-aware edge snapping for resize of rotated/mirrored objects.
     *
     * Takes a rect expressed in the object's LOCAL axes plus its world pose,
     * projects the corners into canvas space, snaps the resulting world AABB
     * edges, and maps the correction back into local axes. Guides stay plain
     * H/V lines (AABB edges are axis-aligned by construction).
     */
    snapEdgeRotated: (
      localRect: Rect,
      handle: string,
      pose: { rotation: number, flip: { h: boolean, v: boolean }, startCenter: { cx: number, cy: number }, startLocalRect: Rect },
      frame: Frame,
      options?: { threshold?: number, snapToCanvas?: boolean, snapToLayers?: boolean, maxSnapTargets?: number }
    ) => { rect: Rect, smartguides: SmartGuideData | null };
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
    intersectWithLayer: (shape: LocalShape, layer: Layer) => { visibleShape: LocalShape, center: Point2D, featherPx: number } | null;
    /** Converts local coordinate shape to world coordinate shape (atomic tool) */
    localToWorldShape: (shape: Shape, source: Layer | Frame) => WorldShape;
    /** Converts world coordinate shape to local coordinate shape (atomic tool) */
    worldToLocalShape: (shape: WorldShape, target: Layer | Frame) => LocalShape;
    /** Projects layer local shape to artboard space (used for rendering highlight/bounding-box) */
    layerLocalToFrameLocal: (shape: Shape, layer: Layer, frame: Frame) => LocalShape;
    /** Calculates joint bounding box shape of a set of layers in world space */
    unitedShapeOfLayers: (layers: Layer[]) => WorldShape | null;
    /**
     * Pure-scale (no translation) all absolute coordinates in an SVG path string.
     * Used by the resample/resize pipeline to map pathData from the old src
     * coordinate system to the new one.
     */
    scalePathData: (pathData: string, scaleX: number, scaleY: number) => string;
  };

  /**
   * Polygon engine service: independent multi-ring vector polygon utilities for irregular selection.
   * Parallel to `shape.*` and intentionally kept separate.
   */
  polygon: {
    /** Computes axis-aligned bounding box of a multi-ring point set (no brand). */
    computePolygonBounds: (rings: Point2D[][]) => Rect;
    /** Projects polygon from local space to world space (Layer or Frame source). */
    localToWorldPolygon: (poly: LocalPolygon, source: Layer | Frame) => WorldPolygon;
    /** Projects polygon from world space to local space (Layer or Frame target). */
    worldToLocalPolygon: (poly: WorldPolygon, target: Layer | Frame) => LocalPolygon;
    /** Composes frame-local -> world -> layer-local polygon projection. */
    frameLocalToLayerLocal: (poly: LocalPolygon, frame: Frame, layer: Layer) => LocalPolygon;
    /** Inverse: layer-local -> world -> frame-local polygon projection. */
    layerLocalToFrameLocal: (poly: LocalPolygon, layer: Layer, frame: Frame) => LocalPolygon;
    /**
     * Generates a multi-ring SVG path `d` string (relative to `poly.rect.x/y`),
     * suitable for evenodd fill rule rendering.
     *
     * `gridOffset` — WHERE the TARGET layer's document-pixel-grid lines fall:
     * the fractional part (0 or 0.5) of the layer's origin in ring space; the
     * aa/na pixel-staircase ants must be computed on that grid to coincide
     * with the GPU-cut pixels (ignored by the smooth `ss` mode).
     *
     * `window` — optional visible-window bounds in grid cell index space
     * (inclusive k0..k1 × r0..r1): the aa/na staircase is derived ONLY for
     * cells inside (viewport culling — the ants' raster cost stops scaling
     * with the full selection perimeter × device zoom). Contours close along
     * the window edges, so stroke/fill stay correct inside the window.
     */
    polygonToSvgPathD: (
      poly: LocalPolygon,
      gridOffset?: { readonly x: number; readonly y: number },
      window?: { readonly k0: number; readonly r0: number; readonly k1: number; readonly r1: number },
    ) => string;
    /**
     * Resolves the display-edge mode from the shape flags (`ssdepMode ⇒
     * antiAliased` invariant repaired on read): 'ss' smooth SSDEP display,
     * 'aa' AA on, 'na' AA off. The aa/na modes share ONE pixel staircase.
     */
    deriveEdgeDisplayMode: (antiAliased?: boolean, ssdepMode?: boolean) => 'ss' | 'aa' | 'na';
    /**
     * Determines whether a point lies inside a multi-ring polygon using ray-casting
     * (even-odd rule). Useful for hit-testing clicks against irregular selections.
     */
    isPointInPolygon: (point: Point2D, rings: Point2D[][]) => boolean;
    /**
     * Calculates the unsigned area of a single closed ring using the Shoelace formula.
     * Returns absolute value regardless of winding direction.
     */
    computeRingArea: (ring: Point2D[]) => number;
    /**
     * Douglas–Peucker simplification for an open polyline. Retains first/last vertices
     * and drops intermediate points within `epsilon` perpendicular distance of the
     * simplified line.
     */
    simplifyOpen: (points: Point2D[], epsilon: number) => Point2D[];
    /**
     * Douglas–Peucker simplification for a closed polygon ring. Wraps the ring into
     * an open polyline, simplifies, then removes the trailing duplicate.
     */
    simplifyRing: (ring: Point2D[], epsilon: number) => Point2D[];
    /**
     * Translates all rings in a LocalPolygon by (dx, dy). Returns a new polygon
     * with offset points and bounding rect. Used by the selection-move handler.
     */
    translatePolygon: (poly: LocalPolygon, dx: number, dy: number) => LocalPolygon;
    /**
     * Scales all rings of a LocalPolygon by (sx, sy) around an anchor point.
     * Returns a new polygon with recomputed bounding rect. Used by the
     * selection-transform handler (irregular selection corner handles).
     */
    /**
     * Scales a polygon by (sx, sy). With `angleRad` (radians, typically the
     * polygon's orientationDeg) the factors stretch along the polygon's OWN
     * axes — a rotated rectangle stays a rectangle under non-uniform scale.
     * Absent (0) is the historical canvas-axis scale.
     */
    scalePolygon: (poly: LocalPolygon, anchor: Point2D, sx: number, sy: number, angleRad?: number) => LocalPolygon;
    /**
     * Rotates all rings of a LocalPolygon around a center point by angleRad
     * (radians, clockwise in the y-down canvas space). Returns a new polygon
     * with recomputed bounding rect. Used by the selection-transform handler.
     */
    rotatePolygon: (poly: LocalPolygon, center: Point2D, angleRad: number) => LocalPolygon;
    /**
     * Scales a polygon by (sx, sy) expressed in the polygon's OWN rotated
     * frame (orientation thetaRad) about a fixed world anchor — the factors
     * stretch along the rotated axes, so a rotated rectangle stays a
     * rectangle under non-uniform scale. At theta = 0 this is bitwise
     * scalePolygon. Used by the selection-transform handler.
     */
    /**
     * The 8-handle gizmo scale factors solved in an entity's OWN rotated
     * frame (pointer already projected into that frame, origin at the
     * rotated-box centre). THE shared solve of the plain selection
     * transform and the selection-driven peel session. Corner handles
     * anchor the opposite corner; edge handles anchor the opposite edge
     * line; negative factors are mirrors; `uniform` keeps both addressed
     * axes at one magnitude.
     */
    solveGizmoResizeScale: (
      mode: 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w',
      pointerLocalX: number,
      pointerLocalY: number,
      boxW: number,
      boxH: number,
      opts?: { uniform?: boolean; minW?: number; minH?: number },
    ) => { sx: number; sy: number };
    /**
     * The gesture-start basis of a gizmo scale on a polygon measured along
     * its OWN orientation thetaRad — the rotated content box (centre +
     * extents) and the world-space anchor point (opposite corner / edge
     * midpoint of the handle). THE shared start-basis of both gizmo scale
     * gestures (plain selection + selection-driven peel session).
     */
    measureGizmoResizeAnchor: (
      poly: LocalPolygon,
      thetaRad: number,
      mode: 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w',
    ) => { cx: number; cy: number; w: number; h: number; anchorX: number; anchorY: number };
    /**
     * Generates a polygon for a regular clip shape.
     * 'rect' produces 4 corners; 'pathellipse' produces the 64-point ellipse
     * approximation ring that polygonToShape recognizes as type:'circle'.
     * Returns a branded LocalPolygon ready for clipBox storage.
     */
    regularShapeToLocalPolygon: (tool: 'rect' | 'pathellipse', rect: LocalRect, flags?: PolygonFlags) => LocalPolygon;
    /** 360-point path-based ellipse polygon (stays on type:'path' pipeline, never recognized as circle) */
    ellipsePathToLocalPolygon: (rect: LocalRect, flags?: PolygonFlags) => LocalPolygon;
    /**
     * Serializes a Polygon into an equivalent Shape descriptor (the lossy, one-way
     * Polygon → Shape entry point). Recognizes 4-point rects and 64-point ellipses
     * as native rect/circle types; all other rings become type:'path' with smooth
     * M/L/Z pathData. Overloaded: LocalPolygon → LocalShape, WorldPolygon → WorldShape.
     */
    polygonToShape: {
      (poly: LocalPolygon): LocalShape;
      (poly: WorldPolygon): WorldShape;
    };

  };

  /**
   * Point2D ring service: raw `Point2D[][]` ↔ container conversions and
   * foundational ring operations. This is the unbranded data layer beneath
   * LocalShape / LocalPolygon.
   *
   * Intentionally separate from `polygon` (branded containers) and `shape`
   * (rendering paths). See dependency layering:
   *   point2d → types only
   *   polygon → point2d (for bounds, polygon construction)
   *   shape   → independent
   */
  point2d: {
    /** Decomposes a LocalShape into plain Point2D rings. */
    shapeToPoint2D: (shape: LocalShape) => Point2D[][];
    /** Attempts to convert Point2D rings back into a LocalShape (null if not representable). */
    point2dToLocalShape: (rings: readonly Point2D[][], antiAliased: boolean) => LocalShape | null;
    /** Builds a LocalPolygon from raw Point2D rings, computing bounding rect automatically. */
    point2dToLocalPolygon: (rings: Point2D[][], flags?: PolygonFlags) => LocalPolygon;
    /** Inverts rings against bounding area (evenodd semantics). Null = empty selection. */
    invertRings: (rings: Point2D[][], boundingW: number, boundingH: number) => Point2D[][] | null;
    /** Checks if a ring matches the canvas bounding rectangle. */
    isBoundingRing: (ring: readonly Point2D[], boundingW: number, boundingH: number) => boolean;
    /** Computes axis-aligned bounding box of a multi-ring point set (no brand). */
    computePolygonBounds: (rings: Point2D[][]) => Rect;
  };

  /**
   * Bézier engine service: pure L0 cubic curve operators for pen-path data —
   * evaluation, arc length, splitting, adaptive flattening (the exit form for
   * mask baking / selections / stroke rendering), nearest-point hit queries,
   * polyline → anchor-chain fitting, and SVG `d` serialization. Parallel to
   * `polygon` / `point2d`; all coordinates are layer-local document pixels
   * (screen-pixel thresholds are converted by the caller).
   */
  bezier: {
    /** Evaluates the cubic bézier B(t) via de Casteljau. */
    evaluateCubic: (p0: Point2D, p1: Point2D, p2: Point2D, p3: Point2D, t: number) => Point2D;
    /** First-derivative tangent vector (not normalized) of the cubic at t. */
    tangentAt: (p0: Point2D, p1: Point2D, p2: Point2D, p3: Point2D, t: number) => Point2D;
    /** Cumulative arc length at adaptive subdivision nodes (last entry = total). */
    arcLengths: (p0: Point2D, p1: Point2D, p2: Point2D, p3: Point2D) => number[];
    /** Splits the cubic at t into two sub-segments joining exactly at B(t). */
    splitCubic: (p0: Point2D, p1: Point2D, p2: Point2D, p3: Point2D, t: number) => [CubicSegment, CubicSegment];
    /** Flattens a cubic chain to a polyline; deviation bounded by toleranceDocPx. */
    flattenCubicChain: (segments: readonly CubicSegment[], toleranceDocPx: number) => Point2D[];
    /** Closest point on a segment chain, or null beyond tolerance. */
    nearestPointOnPath: (path: readonly CubicSegment[], pt: Point2D, tolerance: number) => { t: number; dist: number; segmentIndex: number } | null;
    /** Fits draggable anchors to a dense polyline (Schneider least squares + corner detection). */
    fitCubicsToPolyline: (ring: readonly Point2D[], toleranceDocPx: number, closed: boolean) => PenAnchor[];
    /** Converts an anchor-based pen path into the flat cubic segment chain. */
    penPathToCubicSegments: (path: PenPathData) => CubicSegment[];
    /** Serializes a pen path to an absolute-command SVG `d` string. */
    penPathToSvgD: (path: PenPathData) => string;
    /** Applies an arbitrary point map to every anchor, re-basing relative handle endpoints. */
    mapPathAnchors: (path: PenPathData, map: (pt: Point2D) => Point2D) => PenPathData;
    /** Closest anchor element (anchor or handle endpoint) within tolerance, or null. */
    nearestPathAnchor: (path: PenPathData, pt: Point2D, tolerance: number) => { pathIdx: number; anchorIdx: number; kind: 'anchor' | 'handleIn' | 'handleOut' } | null;
    /** Parses an SVG `d` string (M/L/H/V/C/S/Q/T/Z) into pen path data; arcs throw. */
    svgDToPenPath: (d: string) => PenPathData;
  };
}
