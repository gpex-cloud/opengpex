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

'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';

// ─── useFilterGesture ──────────────────────────────────────────────────────────

/**
 * useFilterGesture — gesture-based Undo coalescing helper for filter panels.
 *
 * Panels invoke `begin()` on `pointerdown` to fire an undoable checkpoint
 * command (empty-body command whose sole purpose is to snapshot layer state
 * into TimeTravel history). During drag, panels call `update()` with the
 * live filter state (each write is non-undoable so the intermediate mutations
 * collapse). `end()` closes the gesture (nothing to commit — the mutations
 * are already durable on the layer; the checkpoint from `begin()` bookends
 * the diff).
 *
 * A short window between `begin` and `end` is tracked so back-to-back panels
 * (or the reset button) can query whether a drag is in progress via
 * `isDragging()`.
 *
 * ═══ v2 SIMPLIFICATION (spec §13.3 / §15) ═══
 *
 * The `filterCache.setDragging(true/false)` calls are GONE. In v1 this hook had a
 * second job: throttling the render pipeline. On `pointerdown` it told
 * `AsyncFilterCache` to stop dispatching full-resolution Worker filter jobs (so
 * a drag wouldn't queue one RPC per tick), and on `pointerup` it re-enabled
 * scheduling for the single settled recipe. It even needed unmount cleanup,
 * because leaving the global flag stuck at `true` would silently wedge the
 * filter pipeline for every later gesture.
 *
 * None of that is necessary now. Adjustments are GPU uniforms / LUT textures
 * evaluated at full resolution every frame in <0.2ms, so there is no expensive
 * job to defer and no shared mutable flag to leak (§2.2, §9).
 *
 * What remains is pure UNDO SEMANTICS — bookending a drag with one history
 * checkpoint — which is a state-layer concern with no rendering coupling at all.
 */
export interface FilterGestureCommand {
  execute?: (payload?: never) => unknown;
}

export interface FilterGestureHandle {
  /** Called on pointerdown. Idempotent within one gesture. */
  begin: () => void;
  /** Called on pointerup / cancel. Idempotent. */
  end: () => void;
  /** True while inside a begin/end pair. */
  isDragging: () => boolean;
}

export function useFilterGesture(
  beginCommand: FilterGestureCommand | undefined,
): FilterGestureHandle {
  const draggingRef = useRef(false);

  const begin = useCallback(() => {
    if (draggingRef.current) return;
    draggingRef.current = true;
    beginCommand?.execute?.();
  }, [beginCommand]);

  const end = useCallback(() => {
    // No-op unless we're actively in a gesture; keeps double-firing safe.
    if (!draggingRef.current) return;
    draggingRef.current = false;
  }, []);

  const isDragging = useCallback(() => draggingRef.current, []);

  // Reset the flag if the panel unmounts mid-drag (tab switch, drawer close) so
  // the next gesture starts from a known good state.
  useEffect(() => {
    return () => {
      draggingRef.current = false;
    };
  }, []);

  return useMemo(
    () => ({ begin, end, isDragging }),
    [begin, end, isDragging],
  );
}
