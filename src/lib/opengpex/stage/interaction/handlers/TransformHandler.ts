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

import { InteractionHandler, InteractionEvent, LocalRect } from '@opengpex/editor/core/types';
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
   * Determine if the interaction should be handled and return structured intent.
   * Return null to skip this handler.
   */
  test: (e: InteractionEvent) => TransformIntent | null;

  /** Get the initial state (e.g., initial rect, crop box) */
  getInitialState: (e: InteractionEvent, intent: TransformIntent) => T;

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
      if (intent.category === 'create') {
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

      if (intent.category === 'move' || intent.sub === 'peel') {
        nextRect = InteractionMath.snapAndSync(e, {
          ...startState,
          x: startState.x + dx,
          y: startState.y + dy
        }, opState, { clamp: constraints.clamp });

        if (constraints.alignToLayerId) {
          nextRect = InteractionMath.alignToPhysicalPixels(e, nextRect, constraints.alignToLayerId);
        } else {
          // Pixel editor invariant: all rect outputs must align to integer pixel grid,
          // regardless of whether canvas clamping is active (e.g. Re-Canvas needs
          // clamp=false to exceed canvas bounds, but still requires integer coordinates).
          nextRect = {
            ...nextRect,
            x: Math.round(nextRect.x),
            y: Math.round(nextRect.y),
            w: Math.round(nextRect.w),
            h: Math.round(nextRect.h)
          } as LocalRect;
        }
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
        const isSnapping = e.state.interaction.isSnapping;

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

        if (constraints.alignToLayerId) {
          nextRect = InteractionMath.alignToPhysicalPixels(e, nextRect, constraints.alignToLayerId);
        } else {
          // Pixel editor invariant: all rect outputs must align to integer pixel grid,
          // regardless of whether canvas clamping is active (e.g. Re-Canvas needs
          // clamp=false to exceed canvas bounds, but still requires integer coordinates).
          nextRect = {
            ...nextRect,
            x: Math.round(nextRect.x),
            y: Math.round(nextRect.y),
            w: Math.round(nextRect.w),
            h: Math.round(nextRect.h)
          } as LocalRect;
        }
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
    }
  };
}
