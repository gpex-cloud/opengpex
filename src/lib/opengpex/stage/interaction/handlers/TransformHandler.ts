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

import { InteractionHandler, InteractionEvent, LocalRect, asWorldPoint } from '@opengpex/editor/core/types';
import { Matrix3x3 } from '@opengpex/editor/core/geometry/matrix';
import { isRotatedPose } from '@opengpex/editor/core/geometry/operators/transform';
import { InteractionMath } from '../Math';
import { InteractionTransaction } from '../Transaction';
import { presets } from '@opengpex/editor/core/helpers/preferences';

// ─── V2 Type System ────────────────────────────────────────────────────────────

/**
 * TransformIntent: Structured return value from test().
 * Describes "what is the intent of this gesture" — the framework uses it to drive subsequent logic.
 */
export interface TransformIntent {
  /** Semantic category: determines gesture matching, onMove branching, pixel alignment strategy */
  category: TransformCategory;
  /** Handle direction for resize operations */
  handle?: ResizeHandle;
  /** Plugin-defined sub-intent (e.g., 'peel', 'rotate-free', 'skew-x') */
  sub?: string;
}

export type TransformCategory = 'resize' | 'create' | 'move' | 'rotate' | 'custom';

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

/**
 * ModifierState: Snapshot of keyboard modifiers at a point in time.
 */
export interface ModifierState {
  shift: boolean;
  meta: boolean;
  alt: boolean;
  ctrl: boolean;
}

/**
 * LayerOrientation: The pose (rotation/flip) of the object being transformed.
 *
 * Supplied by consumers via `TransformHandlerConfig.getOrientation` so the resize
 * math can operate in the object's own local axes instead of the canvas axes.
 * See the "Orientation-aware resize" section on `getOrientation` for details.
 */
export interface LayerOrientation {
  /** Rotation in degrees (layer.rotation) */
  rotation: number;
  /** Mirror flags (layer.flip) */
  flip: { h: boolean; v: boolean };
  /**
   * World-space centre of the object's bounding box (layer.cx / layer.cy).
   *
   * OPTIONAL, but required to get **rotation-aware edge snapping**. The local-axes
   * resize path only knows the object's local rect; to snap its edges against
   * canvas edges / centre lines / other layers, the framework must project that
   * local rect back into canvas space, which needs the world centre it is
   * anchored to. Supply both or neither — when absent, edge snapping is skipped
   * for the rotated path (the resize math itself is unaffected).
   */
  cx?: number;
  cy?: number;
}

/**
 * TransformContext: Created at onStart, available throughout the gesture lifecycle.
 */
export interface TransformContext {
  /** The gesture's intent (from test()) */
  intent: TransformIntent;
  /** Canvas coordinates at mouse-down */
  startCanvas: { x: number; y: number };
  /** Modifier snapshot at gesture start */
  startModifiers: ModifierState;
  /** Gesture start time (Date.now()) */
  startTime: number;
  /** Unique incrementing ID for this gesture */
  generation: number;
  /**
   * Non-null when the gesture is running in orientation-aware mode, i.e. the
   * rect passed to `onUpdate` is expressed in the object's LOCAL axes rather
   * than canvas axes. Consumers that opt into `getOrientation` must check this
   * to interpret the rect correctly (see `getOrientation` docs).
   */
  orientation?: LayerOrientation | null;
}

/**
 * TransformEndContext: Extended context available only in onEnd / gesture actions.
 */
export interface TransformEndContext extends TransformContext {
  /** Framework pre-computed: is this a static click (distance < threshold)? */
  isStatic: boolean;
  /** Framework pre-computed: is this a double-click (isStatic && detail===2)? */
  isDoubleClick: boolean;
  /** Framework pre-computed: did onUpdate produce ≥1px integer displacement? (deterministic) */
  hasMoved: boolean;
  /** Whether a gesture rule matched and executed before onEnd */
  gestureMatched: boolean;
  /** Name of the matched gesture rule (for debug), or null if none matched */
  matchedGesture: string | null;
  /** Modifier snapshot at gesture end */
  endModifiers: ModifierState;
  /** Total displacement (canvas space) */
  totalDelta: { x: number; y: number };
  /** Gesture duration (ms) */
  duration: number;
}

/**
 * GestureRule: A declarative gesture matching rule.
 * Framework iterates rules in order at onEnd; first match wins.
 */
export interface GestureRule {
  /** Rule name (for debug logging) */
  name: string;
  /** Match predicate: receives full end context, returns whether it fires */
  match: (ctx: TransformEndContext) => boolean;
  /** Action to execute when matched */
  action: (e: InteractionEvent, tx: InteractionTransaction, ctx: TransformEndContext) => void | Promise<void>;
  /** Async strategy: 'await' (default) or 'fire-and-forget' */
  asyncStrategy?: 'await' | 'fire-and-forget';
}

/**
 * Built-in gesture matchers (convenience factories).
 */
export const GestureMatcher = {
  staticClick: (categories?: TransformCategory[]) =>
    (ctx: TransformEndContext) => ctx.isStatic && (!categories || categories.includes(ctx.intent.category)),
  doubleClick: (categories?: TransformCategory[]) =>
    (ctx: TransformEndContext) => ctx.isDoubleClick && (!categories || categories.includes(ctx.intent.category)),
};

// ─── Config Interface ──────────────────────────────────────────────────────────

export interface TransformHandlerConfig<T = LocalRect> {
  id: string;
  priority?: number;

  /**
   * Whether to clamp the anchor point to canvas bounds for 'create' category.
   * Default: true (Photoshop Marquee behavior — outside-canvas clicks snap to nearest edge).
   * Set to false for Re-Canvas, which needs to allow anchors beyond canvas bounds.
   */
  clampAnchor?: boolean;

  /**
   * Determine if the interaction should be handled and return structured intent.
   * Return null to skip this handler.
   */
  test: (e: InteractionEvent) => TransformIntent | null;

  /** Get the initial state (e.g., initial rect, crop box) */
  getInitialState: (e: InteractionEvent, intent: TransformIntent) => T;

  /**
   * [Orientation-aware resize — opt-in]
   *
   * Return the pose (rotation/flip) of the object being resized, or null/undefined
   * for plain axis-aligned objects.
   *
   * WHY: the resize math is fundamentally "resize an axis-aligned rect". For an
   * object carrying a non-zero `rotation` (e.g. a marker layer after a canvas
   * Rotate Left/Right, where `transformFrame` bumps `layer.rotation` but leaves
   * `layer.bounding` untouched), the canvas axes and the object's own axes no
   * longer coincide — dragging the visually-"east" handle must grow the object
   * along ITS OWN local x axis, not the canvas x axis. Supplying the orientation
   * lets the framework map the pointer delta through the inverse orientation
   * matrix so the single resize algorithm runs in the object's local axes.
   *
   * CONTRACT when a non-zero orientation is returned:
   *   - `onUpdate` receives a rect in the object's LOCAL axes: `w`/`h` are the
   *     new local dimensions, and `x`/`y` are the local top-left. Consumers
   *     typically only need `w`/`h` plus the framework-provided local centre
   *     (recoverable from the rect) and should write them straight to
   *     `bounding` / `cx`+`cy`.
   *   - `context.orientation` is non-null, so consumers can assert the space.
   *   - Edge snapping is skipped (see the rotated-snapEdge TODO in
   *     `docs/opengpex/plans/v1/20260905_transform_handler_rotation_aware_resize.md`):
   *     `snapEdge` compares canvas-axis edges and cannot express a rotated edge.
   *
   * When this returns null/undefined, or `rotation === 0` with no flip, the
   * gesture takes the original canvas-space code path byte-for-byte (this keeps
   * ClipOverlay's pixel-exact behaviour and its edge snapping intact).
   */
  getOrientation?: (e: InteractionEvent, intent: TransformIntent) => LayerOrientation | null | undefined;

  /** Get constraints such as aspect ratio, whether to clamp to canvas, or a specific layer ID to snap to. */
  getConstraints?: (e: InteractionEvent, intent: TransformIntent) => {
    aspect?: number;
    clamp?: boolean;
    alignToLayerId?: string;
  };

  /** Called on every frame. Use tx.update() to write to the volatile track. */
  onUpdate: (
    e: InteractionEvent,
    newState: T,
    tx: InteractionTransaction,
    context: TransformContext & { dx: number; dy: number }
  ) => void;

  /**
   * Called when the interaction finishes. ALWAYS executes regardless of gesture matching.
   * Check `context.gestureMatched` to branch if needed. Can be async.
   */
  onEnd?: (e: InteractionEvent, tx: InteractionTransaction, context: TransformEndContext) => void | Promise<void>;

  /** Declarative gesture rules (matched in order, first wins) */
  gestures?: GestureRule[];

  /**
   * Commit strategy:
   * - 'auto' (default): framework auto-commits in finally block
   * - 'manual': plugin controls commit/abort entirely
   */
  commit?: 'auto' | 'manual';

  /** If true or returns true, the transaction runs silently (no undo checkpoint) */
  silent?: boolean | ((e: InteractionEvent, intent: TransformIntent) => boolean);

  /** Called when interaction is cancelled (e.g., Esc). Framework auto-aborts tx before calling. */
  onCancel?: (e: InteractionEvent, context: TransformContext) => void;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function captureModifiers(e: InteractionEvent): ModifierState {
  const me = e.nativeEvent as MouseEvent;
  return {
    shift: me.shiftKey,
    meta: me.metaKey,
    alt: me.altKey,
    ctrl: me.ctrlKey,
  };
}

/**
 * Resolve the resize handle string for internal math from the intent.
 * For 'create' category, the active handle is always 'se' (bottom-right corner expands).
 */
function resolveHandleType(intent: TransformIntent): string {
  if (intent.category === 'create') return 'create';
  if (intent.category === 'resize' && intent.handle) return intent.handle;
  if (intent.category === 'move') return 'move';
  if (intent.sub) return intent.sub; // custom sub-intent (e.g., 'peel')
  return 'move';
}

/**
 * Build the orientation (rotation + mirror) matrix for a layer pose.
 *
 * MUST stay sign-compatible with `getOrientationMatrix` in
 * `core/geometry/operators/transform.ts` (R × F, rotation in degrees), which is
 * what `computeWorldMatrix` (rendering) and `computeLayerMovePose` (move) use.
 * If these two ever disagree, the resize direction would be mirrored relative to
 * what the user sees on screen.
 */
function buildOrientationMatrix(o: LayerOrientation): Matrix3x3 {
  const R = Matrix3x3.rotate(o.rotation);
  const F = new Matrix3x3(o.flip?.h ? -1 : 1, 0, 0, o.flip?.v ? -1 : 1, 0, 0);
  return R.multiply(F);
}

/**
 * Decide whether a supplied orientation actually requires the local-axes path.
 *
 * A zero rotation with no mirroring means canvas axes and local axes coincide,
 * so we deliberately fall through to the original canvas-space math (identical
 * results, zero regression risk, and edge snapping stays available).
 *
 * Delegates to core `isRotatedPose` so the framework and its consumers (the
 * marker/text resize handlers, which call the same helper in `getInitialState`)
 * can never disagree about which space the rect is in.
 */
function needsOrientationPath(o: LayerOrientation | null | undefined): o is LayerOrientation {
  if (!o) return false;
  return isRotatedPose({ rotation: o.rotation, flip: o.flip });
}

/**
 * finalizeRectAlignment: single exit point for the pixel-grid invariant.
 *
 * Every resize/move/create branch must emit integer-aligned rects (the pixel
 * editor requires it even when canvas clamping is off, e.g. Re-Canvas). Two
 * strategies:
 *   - `alignToLayerId` set → snap to that layer's physical pixel grid (handles
 *     the layer's own rotation/flip via alignToPhysicalPixels);
 *   - otherwise → round to the integer canvas grid.
 *
 * Consolidating the three previously-duplicated tails here is the "align as a
 * unified post-process" step of Phase 2 (see the plans doc §4.4). It is a pure
 * refactor: behaviour is identical for all existing consumers.
 */
function finalizeRectAlignment(
  e: InteractionEvent,
  rect: LocalRect,
  alignToLayerId?: string
): LocalRect {
  if (alignToLayerId) {
    return InteractionMath.alignToPhysicalPixels(e, rect, alignToLayerId);
  }
  return {
    ...rect,
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.w),
    h: Math.round(rect.h),
  } as LocalRect;
}

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * createTransformHandler: High-order handler factory (V2)
 * Shields plugin developers from complex math and state transition logic like FastSync,
 * physical alignment, elastic scaling, gesture detection, and transaction lifecycle.
 */
export function createTransformHandler(config: TransformHandlerConfig<LocalRect>): InteractionHandler {
  let generation = 0;
  let intent: TransformIntent | null = null;
  let currentContext: TransformContext | null = null;
  let startState: LocalRect = { x: 0, y: 0, w: 0, h: 0 } as LocalRect;
  let startAnchor = { x: 0, y: 0 };
  let startCanvas = { x: 0, y: 0 };
  let tx: InteractionTransaction | null = null;
  let thresholdCrossed = false; // For 'create' category: has the drag threshold been crossed?
  let _hasMoved = false; // Tracks whether onUpdate produced ≥1px integer displacement

  const opState = { lastThrottleTime: 0 };

  // Internal type string used by resize math (matches handle direction)
  let internalType = '';

  // Orientation-aware resize state (null = plain canvas-axes path).
  // Captured once at onStart because rotation/flip never change mid-gesture.
  let startOrientation: LayerOrientation | null = null;
  let startOrientInverse: Matrix3x3 | null = null;
  // World-space centre + local rect at gesture start. Both are needed to project
  // the local-axes rect back into canvas space for rotation-aware edge snapping
  // (null when the consumer's getOrientation omitted cx/cy → snapping skipped).
  let startWorldCenter: { cx: number; cy: number } | null = null;
  let startLocalRect: LocalRect | null = null;

  return {
    id: config.id,
    priority: config.priority || 100,

    test: (e) => {
      const result = config.test(e);
      if (result) {
        intent = result;
        return true;
      }
      intent = null;
      return false;
    },

    onStart: (e) => {
      if (!intent) return;

      generation++;
      const myGen = generation;

      // Resolve the internal handle type for math calculations
      internalType = resolveHandleType(intent);

      // For 'create' category, start with threshold gate
      thresholdCrossed = intent.category !== 'create';

      _hasMoved = false;
      startState = { ...config.getInitialState(e, intent) };
      startCanvas = { x: e.point.canvas.x, y: e.point.canvas.y };

      // Resolve orientation once. Only a genuinely rotated/mirrored pose switches
      // to the local-axes path; rotation=0 keeps the original canvas-space math.
      const rawOrientation = config.getOrientation ? config.getOrientation(e, intent) : null;
      if (needsOrientationPath(rawOrientation)) {
        startOrientation = rawOrientation;
        startOrientInverse = buildOrientationMatrix(rawOrientation).inverse();
        // Capture the world pose so onMove can project the local rect back into
        // canvas space for rotation-aware edge snapping. cx/cy are optional on
        // LayerOrientation: absent → snapping is skipped, resize math unchanged.
        startWorldCenter = (rawOrientation.cx != null && rawOrientation.cy != null)
          ? { cx: rawOrientation.cx, cy: rawOrientation.cy }
          : null;
        startLocalRect = { ...startState };
      } else {
        startOrientation = null;
        startOrientInverse = null;
        startWorldCenter = null;
        startLocalRect = null;
      }

      let ax = startState.x;
      let ay = startState.y;

      // Calculate opposite anchor based on handle type
      if (internalType.includes('n')) ay = startState.y + startState.h;
      if (internalType.includes('s')) ay = startState.y;
      if (internalType.includes('w')) ax = startState.x + startState.w;
      if (internalType.includes('e')) ax = startState.x;
      if (internalType === 'move' || internalType === 'create' || intent.sub) {
        ax = e.point.canvas.x;
        ay = e.point.canvas.y;
      }

      // For create: clamp the ANCHOR to canvas bounds (Photoshop Marquee behavior)
      // Skip clamping when clampAnchor is explicitly set to false (e.g. Re-Canvas).
      if (intent.category === 'create' && config.clampAnchor !== false) {
        const canvasDim = e.activeFrame.canvas;
        const clamped = e.geometry.space.clampPointToRect({ x: ax, y: ay }, canvasDim);
        ax = clamped.x;
        ay = clamped.y;
      }

      startAnchor = { x: ax, y: ay };

      // Build context
      currentContext = {
        intent,
        startCanvas: { ...startCanvas },
        startModifiers: captureModifiers(e),
        startTime: Date.now(),
        generation: myGen,
        orientation: startOrientation,
      };

      // Initialize Transaction
      tx = new InteractionTransaction(e);
      const isSilent = typeof config.silent === 'function' ? config.silent(e, intent) : !!config.silent;
      tx.begin(isSilent);
    },

    onMove: (e) => {
      if (!tx || !tx.isActive || !intent || !currentContext) return;
      const { dx, dy } = InteractionMath.getCanvasDelta(e, startCanvas);
      const constraints = config.getConstraints ? config.getConstraints(e, intent) : {};

      let nextRect: LocalRect;

      // Threshold gate for 'create' category
      if (!thresholdCrossed) {
        const k = e.activeFrame.camera.k;
        const threshold = Math.min(5, 5 / k);
        if (Math.sqrt(dx * dx + dy * dy) > threshold) {
          thresholdCrossed = true;
          internalType = 'create';
        } else {
          return;
        }
      }

      // ─── Resize/Move dispatch: THREE deliberate paths (do NOT naively merge) ──
      //
      // This looks like duplicated resize math, but the branches encode genuinely
      // different behaviours. Merging them was evaluated and rejected (see the plans
      // doc "待办 A"); the duplication is bounded and intentional. Kept separate on
      // purpose — read this before attempting any unification:
      //
      //   1. move / peel        → translate only.
      //   2. orientation branch → object carries rotation/flip (logical rotation:
      //      marker/text). Resize runs in the object's LOCAL axes; pointer delta is
      //      mapped through the inverse orientation matrix. Edge snapping goes
      //      through `snapEdgeRotated` (world-AABB projection), not the canvas-axis
      //      `snapEdge`.
      //   3. canvas-axis branch → rotation=0 (clip selection, or unrotated layer).
      //      Splits AGAIN into two DIFFERENT interaction models:
      //        · clamp   (crop box): handle follows RELATIVE displacement — the grab
      //                   offset from the corner is preserved for the whole drag.
      //                   Dragged edges are clamped to canvas bounds.
      //        · unclamp (text/marker): corner snaps to the ABSOLUTE pointer world
      //                   position; free to extend past the canvas edge (like PS
      //                   layers, which are never clamped — only crop is).
      //      These two models are NOT interchangeable: with an off-corner grab they
      //      produce different results, and the difference is only observable by hand
      //      (no automated test guards it). This — not rotation — is the real blocker
      //      to collapsing into a single path.
      //
      // If a future merge is ever attempted, the prerequisite is a pixel-exact
      // ClipOverlay baseline test + a product decision on unifying clamp/unclamp feel.
      if (intent.category === 'move' || intent.sub === 'peel') {
        nextRect = InteractionMath.snapAndSync(e, {
          ...startState,
          x: startState.x + dx,
          y: startState.y + dy
        }, opState, { clamp: constraints.clamp });

        nextRect = finalizeRectAlignment(e, nextRect, constraints.alignToLayerId);
      } else if (startOrientation && startOrientInverse) {
        // ─── Orientation-aware resize (local axes) ─────────────────────────
        // The object carries a non-zero rotation/flip, so canvas axes ≠ object
        // axes. We map the pointer delta through the inverse orientation matrix
        // and then run the SAME resize algorithm in the object's local axes.
        //
        // startState is the object's local-axes rect (from getInitialState):
        // x/y = local top-left, w/h = local dimensions. In local space the rect
        // is axis-aligned by definition, which is exactly what the resize math
        // expects — the rotation lives entirely in the delta mapping below.
        const resizeType = internalType === 'create' ? 'se' : internalType;

        // Pointer delta: canvas axes → local axes (pure rotation/mirror, no translation).
        const localDelta = startOrientInverse.apply({ x: dx, y: dy });

        const isHorizontalEdge = internalType === 'e' || internalType === 'w';
        const isVerticalEdge = internalType === 'n' || internalType === 's';
        const ldx = isVerticalEdge ? 0 : localDelta.x;
        const ldy = isHorizontalEdge ? 0 : localDelta.y;

        // Anchor = the FIXED corner/edge; handle = the corner being dragged.
        // Both in local axes.
        //
        // For an axis the handle does NOT address (e.g. the x axis of an 'n'
        // handle), anchor and handle must COINCIDE so the mapped delta is zero on
        // that axis and `calculateResizedRect` restores the original dimension
        // from `startDim` — mirroring the canvas-space path's use of startAnchor.
        const addressesX = internalType.includes('w') || internalType.includes('e');
        const addressesY = internalType.includes('n') || internalType.includes('s');

        const anchorX = internalType.includes('w') ? startState.x + startState.w : startState.x;
        const anchorY = internalType.includes('n') ? startState.y + startState.h : startState.y;

        const handleX = addressesX
          ? (internalType.includes('w') ? startState.x : startState.x + startState.w)
          : anchorX;
        const handleY = addressesY
          ? (internalType.includes('n') ? startState.y : startState.y + startState.h)
          : anchorY;

        const curLocalX = handleX + (addressesX ? ldx : 0);
        const curLocalY = handleY + (addressesY ? ldy : 0);

        const isShiftPressed = (e.nativeEvent as MouseEvent).shiftKey;
        let effectiveAspect = constraints.aspect;
        if (!effectiveAspect && isShiftPressed) {
          effectiveAspect = (startState.w > 0 && startState.h > 0) ? startState.w / startState.h : 1;
        }

        // Reuse the shared, coordinate-system-agnostic rect math.
        const resized = e.geometry.space.calculateResizedRect(
          asWorldPoint({ x: curLocalX, y: curLocalY }),
          asWorldPoint({ x: anchorX, y: anchorY }),
          effectiveAspect,
          resizeType,
          { w: startState.w, h: startState.h }
        );

        // ─── Rotation-aware edge snapping ──────────────────────────────────
        // `resized` is in LOCAL axes, so the canvas-axis `snapEdge` cannot be
        // used directly. `snapEdgeRotated` projects the local rect's corners
        // into canvas space, snaps the resulting world **AABB** edges to the
        // same targets (canvas edges/centres + layer AABBs), then maps the
        // correction back through O⁻¹ onto the dragged local edge(s).
        //
        // AABB semantics keep the guides plain H/V lines (see snapEdgeRotated
        // docs), so SmartGuideData / the SmartGuides renderer are unchanged.
        //
        // Requires the world centre from `getOrientation` (cx/cy). Consumers
        // that omit it keep the previous no-snap behaviour.
        let orientedRect = resized as unknown as LocalRect;
        const isResizeHandleOriented = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].includes(internalType);

        if (
          presets.get('SNAP_ENABLED') &&
          isResizeHandleOriented &&
          startWorldCenter &&
          startLocalRect
        ) {
          const snapped = e.geometry.snapping.snapEdgeRotated(
            orientedRect,
            resizeType,
            {
              rotation: startOrientation.rotation,
              flip: startOrientation.flip,
              startCenter: startWorldCenter,
              startLocalRect,
            },
            e.activeFrame,
            {
              snapToCanvas: presets.get('SNAP_TO_CANVAS'),
              snapToLayers: presets.get('SNAP_TO_LAYERS'),
              maxSnapTargets: presets.get('SNAP_MAX_TARGETS'),
            }
          );
          orientedRect = snapped.rect as LocalRect;
          e.actions.fast.setTransient('smartguides', snapped.smartguides);
        } else {
          e.actions.fast.setTransient('smartguides', null);
        }

        // Pixel-grid invariant (dimensions are in local pixels). The orientation
        // path never uses alignToLayerId, so this always rounds — pass undefined
        // to keep that behaviour explicit via the shared exit point.
        nextRect = finalizeRectAlignment(e, orientedRect, undefined);
      } else {
        // Resizing logic (category = 'resize' or 'create')
        const resizeType = internalType === 'create' ? 'se' : internalType;
        const isResizeHandle = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].includes(internalType);
        const initialHandleX = (isResizeHandle && internalType.includes('w')) ? startState.x : ((isResizeHandle && internalType.includes('e')) ? startState.x + startState.w : startAnchor.x);
        const initialHandleY = (isResizeHandle && internalType.includes('n')) ? startState.y : ((isResizeHandle && internalType.includes('s')) ? startState.y + startState.h : startAnchor.y);

        // For single-axis edge handles, lock the perpendicular axis
        const isHorizontalEdge = internalType === 'e' || internalType === 'w';
        const isVerticalEdge = internalType === 'n' || internalType === 's';
        const curX = initialHandleX + (isVerticalEdge ? 0 : dx);
        const curY = initialHandleY + (isHorizontalEdge ? 0 : dy);

        const isShiftPressed = (e.nativeEvent as MouseEvent).shiftKey;
        let effectiveAspect = constraints.aspect;
        if (!effectiveAspect && isShiftPressed) {
          effectiveAspect = (startState.w > 0 && startState.h > 0) ? startState.w / startState.h : 1;
        }

        // Read edge snap scope from PresetsFactory
        const edgeSnapScope = presets.get('SNAP_EDGE_SCOPE');
        const isSnapping = presets.get('SNAP_ENABLED');

        if (constraints.clamp) {
          nextRect = InteractionMath.calculateElasticRect(e, {
            curX, curY, startAnchor,
            startBox: { w: startState.w, h: startState.h },
            aspect: effectiveAspect,
            resizeType,
            canvasDim: e.activeFrame.canvas,
            maxPush: { x: 0, y: 0 }
          });

          // Edge snapping for clamped resize
          if (isSnapping && isResizeHandle && edgeSnapScope === 'all') {
            const snapped = e.geometry.snapping.snapEdge(nextRect, resizeType, e.activeFrame, {
              snapToCanvas: presets.get('SNAP_TO_CANVAS'),
              snapToLayers: presets.get('SNAP_TO_LAYERS'),
              maxSnapTargets: presets.get('SNAP_MAX_TARGETS'),
            });
            nextRect = snapped.rect as LocalRect;
            e.actions.fast.setTransient('smartguides', snapped.smartguides);
          } else {
            // Clear explicitly, like every other snap site. Previously this branch
            // had no else and relied on downstream fallbacks (useFastSync's
            // `interacting` check + the post-commit rAF cleanup) to hide stale
            // guides — correct only by coincidence.
            e.actions.fast.setTransient('smartguides', null);
          }
        } else {
          // Unclamped bounding box scaling
          const worldPoint = e.point.world;
          const worldAnchor = e.geometry.space.localToWorld(startAnchor.x, startAnchor.y, e.activeFrame);

          nextRect = e.geometry.space.worldToLocalRect(e.geometry.space.calculateResizedRect(
            worldPoint,
            worldAnchor,
            effectiveAspect,
            resizeType,
            { w: startState.w, h: startState.h }
          ), e.activeFrame);

          // Edge snapping
          if (isSnapping && isResizeHandle) {
            const snapped = e.geometry.snapping.snapEdge(nextRect, resizeType, e.activeFrame, {
              snapToCanvas: presets.get('SNAP_TO_CANVAS'),
              snapToLayers: presets.get('SNAP_TO_LAYERS'),
              maxSnapTargets: presets.get('SNAP_MAX_TARGETS'),
            });
            nextRect = snapped.rect as LocalRect;
            e.actions.fast.setTransient('smartguides', snapped.smartguides);
          } else {
            e.actions.fast.setTransient('smartguides', null);
          }
        }

        nextRect = finalizeRectAlignment(e, nextRect, constraints.alignToLayerId);
      }

      config.onUpdate(e, nextRect, tx, { ...currentContext, dx, dy });

      // Track hasMoved: set once onUpdate produces ≥1px integer displacement
      if (!_hasMoved) {
        const adx = Math.abs(nextRect.x - startState.x);
        const ady = Math.abs(nextRect.y - startState.y);
        if (adx >= 1 || ady >= 1) _hasMoved = true;
      }
    },

    onEnd: async (e) => {
      if (!tx || !tx.isActive || !currentContext) return;

      const myGen = currentContext.generation;
      const endModifiers = captureModifiers(e);
      const { dx, dy } = InteractionMath.getCanvasDelta(e, startCanvas);
      const isStatic = InteractionMath.isStaticClick(e, startCanvas);
      const isDoubleClick = InteractionMath.isDoubleClick(e, startCanvas);

      const endContext: TransformEndContext = {
        ...currentContext,
        isStatic,
        isDoubleClick,
        hasMoved: _hasMoved,
        gestureMatched: false,
        matchedGesture: null,
        endModifiers,
        totalDelta: { x: dx, y: dy },
        duration: Date.now() - currentContext.startTime,
      };

      try {
        // 1. Gesture matching (pre-end interceptors, in declaration order, first wins)
        if (config.gestures) {
          for (const rule of config.gestures) {
            if (rule.match(endContext)) {
              if (rule.asyncStrategy === 'fire-and-forget') {
                rule.action(e, tx, endContext);
              } else {
                await rule.action(e, tx, endContext);
              }
              endContext.gestureMatched = true;
              endContext.matchedGesture = rule.name;
              break;
            }
          }
        }

        // 2. onEnd ALWAYS executes (lifecycle symmetry: onStart↔onEnd)
        // Consumers can check ctx.gestureMatched to branch if needed.
        if (config.onEnd) {
          await config.onEnd(e, tx, endContext);
        }
      } finally {
        // 3. Generation check: if a new gesture started during async, don't commit stale tx
        if (generation !== myGen) {
          tx = null;
          currentContext = null;
          return;
        }

        // 4. Auto-commit guarantee (unless manual mode)
        if (tx && tx.isActive && config.commit !== 'manual') {
          tx.commit();
        } else if (tx) {
        }
      }

      tx = null;
      currentContext = null;
      intent = null;
      internalType = '';
      startOrientation = null;
      startOrientInverse = null;
      startWorldCenter = null;
      startLocalRect = null;
    },

    onCancel: (e) => {
      if (tx?.isActive) {
        tx.abort();
      }
      if (currentContext) {
        config.onCancel?.(e, currentContext);
      }
      tx = null;
      currentContext = null;
      intent = null;
      internalType = '';
      startOrientation = null;
      startOrientInverse = null;
      startWorldCenter = null;
      startLocalRect = null;
    }
  };
}
