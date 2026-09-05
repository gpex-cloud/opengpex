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
/* eslint-disable react-hooks/refs */

import { useRef, useEffect, useCallback } from 'react';
import { Layer, Frame } from '@opengpex/editor/core/types';
import { useAnimate } from '@opengpex/editor/core/motion/hooks/animation';
import { Motion } from '@opengpex/editor/core/motion';

/**
 * useLayerTweens: Layer property tween animation management
 * Senses changes in layer properties (e.g. rotation) and drives GSAP tween animations,
 * ensuring Canvas rendering gets smooth intermediate values.
 */
export function useLayerTweens(activeFrame: Frame | null) {
  const tweenMapRef = useRef<Map<string, { rotation: number }>>(new Map());
  const prevStatesRef = useRef<Map<string, number>>(new Map());
  const layerIdsCacheRef = useRef<Set<string>>(new Set());
  const { animate } = useAnimate(activeFrame?.rotation || 0);

  // --- 1. Real-time animation sensing (Render Phase Detection) ---
  // Compare directly in render phase to ensure isAnimating takes effect on the first frame, preventing Ticker front-running and crop flickering
  let isAnyAnimating = false;
  if (activeFrame) {
    for (let i = 0; i < activeFrame.layers.order.length; i++) {
      const layerId = activeFrame.layers.order[i];
      const layer = activeFrame.layers.byId[layerId];
      const lastRot = prevStatesRef.current.get(layer.id);
      if ((lastRot !== undefined && lastRot !== layer.rotation) || tweenMapRef.current.has(layer.id)) {
        isAnyAnimating = true;
        // [Perf Log]
        if ((window as unknown as Record<string, unknown>)._DEBUG_PERF) {
          console.debug(`[useLayerTweens:Perf] Render Phase short-circuited at layer ${i + 1}/${activeFrame.layers.order.length}`);
        }
        break; // Performance optimization: break immediately if an animating layer is found, avoiding traversal of subsequent layers
      }
    }
  }

  // --- 2. Animation scheduling (Effect Phase Scheduling) ---
  useEffect(() => {
    if (activeFrame) {
      activeFrame.layers.order.forEach((layerId: string) => {
        const layer = activeFrame.layers.byId[layerId];
        const lastRot = prevStatesRef.current.get(layer.id);
        if (lastRot !== undefined && lastRot !== layer.rotation) {
          // ────────────────────────────────────────────────────────────────────
          // [2026-09-06] Always instant-snap — tween branch REMOVED.
          //
          // History: the original code had an `else` branch that triggered a
          // GSAP tween for non-90° rotation deltas, intended as future-proofing
          // for smooth rotation effects. When RotationHandler (free-rotation)
          // landed, this caused a visible "double rotation" artifact on marker
          // layers: the user drags to rotate (60fps fast-track preview), releases
          // → tx.commit() writes the final angle to Redux → useLayerTweens sees
          // a non-90° delta → plays a tween that RE-ANIMATES the same change
          // the user already watched live. Text didn't show it because its DOM
          // overlay occludes the canvas tween.
          //
          // The tween is wrong for EVERY current rotation source:
          //   • Canvas ±90°: viewport swap-rotate compensation handles it
          //   • Free-rotation: fast-track handled it; commit is just persistence
          //   • Undo / structural reset: should be instantaneous by nature
          //
          // If future requirements need a post-commit animation (e.g. "snap to
          // nearest 90°" with ease), add it as a new opt-in code path here,
          // gated by an explicit flag — do NOT restore the unconditional tween.
          // ────────────────────────────────────────────────────────────────────
          if (tweenMapRef.current.has(layer.id)) {
            const tweenTarget = tweenMapRef.current.get(layer.id)!;
            Motion.set(tweenTarget, { rotation: layer.rotation });
            tweenMapRef.current.delete(layer.id);
          }
        }
        prevStatesRef.current.set(layer.id, layer.rotation);
      });

      // Clean up references of deleted layers
      // [GC Extreme Optimization]: No longer use activeFrame.layers.map and new Set to create short-lived objects out of thin air
      if (tweenMapRef.current.size > 0 || prevStatesRef.current.size > 0) {
        const currentLayerIds = layerIdsCacheRef.current;
        currentLayerIds.clear();
        for (let i = 0; i < activeFrame.layers.order.length; i++) {
          currentLayerIds.add(activeFrame.layers.order[i]);
        }

        let gcCount = 0;
        for (const id of tweenMapRef.current.keys()) {
          if (!currentLayerIds.has(id)) {
            tweenMapRef.current.delete(id);
            prevStatesRef.current.delete(id);
            gcCount++;
          }
        }
        
        // [Perf Log]
        if ((window as unknown as Record<string, unknown>)._DEBUG_PERF && gcCount > 0) {
          console.debug(`[useLayerTweens:Perf] GC Phase removed ${gcCount} orphaned tween(s). Reused Set size: ${currentLayerIds.size}`);
        }
      }
    }
  }, [activeFrame, animate]);

  const getAnimatedRotation = useCallback((layer: Layer) => {
    const tweenData = tweenMapRef.current.get(layer.id);
    return tweenData ? tweenData.rotation : layer.rotation;
  }, []);

  return {
    getAnimatedRotation,
    isAnimating: isAnyAnimating
  };
}
