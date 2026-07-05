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

export interface TransformHandlerConfig<T> {
  id: string;
  priority?: number;

  /**
   * Determine if the interaction should be handled and return the handle type.
   * e.g., 'move', 'nw', 'se', 'potential_create'
   */
  test: (e: InteractionEvent) => string | null;

  /**
   * Get the initial state (e.g., initial rect, crop box)
   */
  getInitialState: (e: InteractionEvent) => T;

  /**
   * Get constraints such as aspect ratio, whether to clamp to canvas, or a specific layer ID to snap to.
   */
  getConstraints?: (e: InteractionEvent) => {
    aspect?: number;
    clamp?: boolean;
    alignToLayerId?: string;
  };

  /**
   * Called on every frame. Use tx.update() to write to the volatile track.
   */
  onUpdate: (
    e: InteractionEvent,
    newState: T,
    tx: InteractionTransaction,
    context: { dx: number; dy: number; type: string }
  ) => void;

  /**
   * Called when the interaction finishes.
   */
  onEnd?: (e: InteractionEvent, tx: InteractionTransaction, startCanvas: { x: number; y: number }) => void;

  /**
   * If true or returns true, the interaction transaction is run silently (no undo checkpoint is generated)
   */
  silent?: boolean | ((e: InteractionEvent) => boolean);
}

/**
 * createTransformHandler: High-order handler factory
 * Shields plugin developers from complex math and state transition logic like FastSync, physical alignment, and elastic scaling.
 */
export function createTransformHandler(config: TransformHandlerConfig<LocalRect>): InteractionHandler {
  let type = '';
  let startState: LocalRect = { x: 0, y: 0, w: 0, h: 0 } as LocalRect;
  let startAnchor = { x: 0, y: 0 };
  let startCanvas = { x: 0, y: 0 };
  let tx: InteractionTransaction | null = null;
  
  const opState = { lastThrottleTime: 0 };

  return {
    id: config.id,
    priority: config.priority || 100,

    test: (e) => {
      const resultType = config.test(e);
      if (resultType) {
        type = resultType;
        return true;
      }
      return false;
    },

    onStart: (e) => {
      startState = { ...config.getInitialState(e) };
      startCanvas = { x: e.point.canvas.x, y: e.point.canvas.y };
      
      let ax = startState.x;
      let ay = startState.y;
      
      // Calculate opposite anchor based on handle type
      if (type.includes('n')) ay = startState.y + startState.h;
      if (type.includes('s')) ay = startState.y;
      if (type.includes('w')) ax = startState.x + startState.w;
      if (type.includes('e')) ax = startState.x;
      if (type === 'move' || type === 'potential_create') {
        ax = e.point.canvas.x;
        ay = e.point.canvas.y;
      }

      // For potential_create: clamp the ANCHOR to canvas bounds so that
      // clicks outside the canvas start the selection at the nearest edge
      // (Photoshop Marquee behavior). startCanvas stays at the raw click
      // position so delta calculation remains correct (dx=0 for static clicks,
      // avoiding phantom threshold triggers).
      if (type === 'potential_create') {
        const canvasDim = e.activeFrame.canvas;
        const clamped = e.geometry.space.clampPointToRect({ x: ax, y: ay }, canvasDim);
        ax = clamped.x;
        ay = clamped.y;
      }

      startAnchor = { x: ax, y: ay };

      // Initialize Transaction
      tx = new InteractionTransaction(e);
      // Support running interaction silently to avoid triggering SIGNAL_COMMIT (no intermediate undo checkpoints)
      const isSilent = typeof config.silent === 'function' ? config.silent(e) : !!config.silent;
      tx.begin(isSilent);
    },

    onMove: (e) => {
      if (!tx) return;
      const { dx, dy } = InteractionMath.getCanvasDelta(e, startCanvas);
      const constraints = config.getConstraints ? config.getConstraints(e) : {};

      let nextRect: LocalRect;

      if (type === 'potential_create') {
        // Threshold is dynamically adjusted in canvas space based on zoom level:
        // High zoom levels allow tiny drag to establish selection (precise pixel-level operations)
        // Low zoom levels maintain sufficient threshold to prevent accidental triggers
        const k = e.activeFrame.camera.k;
        const threshold = Math.min(5, 5 / k);
        if (Math.sqrt(dx * dx + dy * dy) > threshold) {
          type = 'create';
        } else {
          return;
        }
      }

      if (type === 'move' || type === 'peel') {
        nextRect = InteractionMath.snapAndSync(e, { 
          ...startState, 
          x: startState.x + dx, 
          y: startState.y + dy 
        }, opState, { clamp: constraints.clamp });

        if (constraints.alignToLayerId) {
          nextRect = InteractionMath.alignToPhysicalPixels(e, nextRect, constraints.alignToLayerId);
        } else if (constraints.clamp) {
          // Additional physical rounding for canvas
          nextRect = {
            ...nextRect,
            x: Math.round(nextRect.x),
            y: Math.round(nextRect.y),
            w: Math.round(nextRect.w),
            h: Math.round(nextRect.h)
          } as LocalRect;
        }
      } else {
        // Resizing logic
        const isResizeHandle = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].includes(type);
        const initialHandleX = (isResizeHandle && type.includes('w')) ? startState.x : ((isResizeHandle && type.includes('e')) ? startState.x + startState.w : startAnchor.x);
        const initialHandleY = (isResizeHandle && type.includes('n')) ? startState.y : ((isResizeHandle && type.includes('s')) ? startState.y + startState.h : startAnchor.y);

        // For single-axis edge handles, lock the perpendicular axis to prevent
        // the box from flipping when the user accidentally drags perpendicular
        // to the edge's normal direction (e.g., dragging left-edge up/down).
        const isHorizontalEdge = type === 'e' || type === 'w';
        const isVerticalEdge = type === 'n' || type === 's';
        const curX = initialHandleX + (isVerticalEdge ? 0 : dx);
        const curY = initialHandleY + (isHorizontalEdge ? 0 : dy);
        const resizeType = type === 'create' ? 'se' : type;

        const isShiftPressed = (e.nativeEvent as MouseEvent).shiftKey;
        let effectiveAspect = constraints.aspect;
        if (!effectiveAspect && isShiftPressed) {
          effectiveAspect = (startState.w > 0 && startState.h > 0) ? startState.w / startState.h : 1;
        }

        if (constraints.clamp) {
          // Standard bounding box scaling (Elastic Rect)
          nextRect = InteractionMath.calculateElasticRect(e, {
            curX, curY, startAnchor,
            startBox: { w: startState.w, h: startState.h },
            aspect: effectiveAspect,
            resizeType,
            canvasDim: e.activeFrame.canvas,
            maxPush: { x: 0, y: 0 }
          });
        } else {
          // Clamped bounding box scaling
          const worldPoint = e.point.world;
          const worldAnchor = e.geometry.space.localToWorld(startAnchor.x, startAnchor.y, e.activeFrame);
          
          nextRect = e.geometry.space.worldToLocalRect(e.geometry.space.calculateResizedRect(
            worldPoint,
            worldAnchor,
            effectiveAspect,
            resizeType,
            { w: startState.w, h: startState.h }
          ), e.activeFrame);
        }

        if (constraints.alignToLayerId) {
          nextRect = InteractionMath.alignToPhysicalPixels(e, nextRect, constraints.alignToLayerId);
        } else if (constraints.clamp) {
          nextRect = {
            ...nextRect,
            x: Math.round(nextRect.x),
            y: Math.round(nextRect.y),
            w: Math.round(nextRect.w),
            h: Math.round(nextRect.h)
          } as LocalRect;
        }
      }

      config.onUpdate(e, nextRect, tx, { dx, dy, type });
    },

    onEnd: (e) => {
      if (!tx) return;

      if (config.onEnd) {
        config.onEnd(e, tx, startCanvas);
      } else {
        tx.commit();
      }

      tx = null;
      type = '';
    }
  };
}
