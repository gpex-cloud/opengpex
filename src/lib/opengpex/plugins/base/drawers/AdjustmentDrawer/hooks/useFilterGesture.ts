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
import { filterCache } from '@opengpex/editor/core/engine/filters';

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
 * `isDragging()` — useful for skipping expensive full-res AsyncFilterCache
 * warmups while the user is still dragging (spec §5.3 Dual-Track preview).
 *
 * Design note: Steps 6 and 7 will invoke this same hook with different
 * `beginCommand` refs (`beginLevelsEditCmd` / `beginChannelMixEditCmd`);
 * the hook itself is deliberately command-agnostic to enable reuse.
 */
export interface FilterGestureCommand {
  execute?: (payload?: never) => unknown;
}

export interface FilterGestureHandle {
  /** Called on pointerdown. Idempotent within one gesture. */
  begin: () => void;
  /** Called on pointerup / cancel. Idempotent. */
  end: () => void;
  /** True while inside a begin/end pair. Useful for preview/full-res dispatch. */
  isDragging: () => boolean;
}

export function useFilterGesture(
  beginCommand: FilterGestureCommand | undefined,
): FilterGestureHandle {
  const draggingRef = useRef(false);

  const begin = useCallback(() => {
    if (draggingRef.current) return;
    draggingRef.current = true;
    // Dual-Track preview (spec §5.3): tell the AsyncFilterCache to stop
    // scheduling worker jobs — painter will paint from `getStale()` for
    // the duration of the drag so we don't drown the worker in per-tick
    // recipes. See `AsyncFilterCache.setDragging` for the schedule-side
    // suppression logic.
    filterCache.setDragging(true);
    // [Filter Fast-Track §2.3] TileFilterCache removed.
    beginCommand?.execute?.();
  }, [beginCommand]);

  const end = useCallback(() => {
    // No-op unless we're actively in a gesture; keeps double-firing safe.
    if (!draggingRef.current) return;
    draggingRef.current = false;
    // Re-enable full-res scheduling. AsyncFilterCache internally notifies
    // subscribers so the next paint pass schedules exactly one Worker
    // job for the final settled recipe (§5.3 commit).
    filterCache.setDragging(false);
    // [Filter Fast-Track §2.3] TileFilterCache removed.
  }, []);

  const isDragging = useCallback(() => draggingRef.current, []);

  // Belt-and-suspenders cleanup: if the panel unmounts mid-drag (tab
  // switch, drawer close), we must reset the global cache flag so the
  // NEXT gesture starts from a known good state. Without this the
  // schedule() guard could stick to `true` forever.
  useEffect(() => {
    return () => {
      if (draggingRef.current) {
        draggingRef.current = false;
        filterCache.setDragging(false);
        // [Filter Fast-Track §2.3] TileFilterCache removed.
      }
    };
  }, []);

  return useMemo(
    () => ({ begin, end, isDragging }),
    [begin, end, isDragging],
  );
}
