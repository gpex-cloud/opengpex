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

import { useRef, useEffect, useMemo } from 'react';
import type { EditorState, EditorActions, BuiltPlugin } from '@opengpex/editor/core/types';

/**
 * useDrawerReveal — Declarative Drawer auto-reveal engine
 *
 * Performance design:
 * 1. Does NOT depend on entire `state` object as useEffect dependency (avoids high-frequency re-runs)
 * 2. Uses useMemo to pre-compute all condition results; effect only fires when results actually change
 * 3. Condition functions run inside useMemo (synchronous, no side effects); effect only dispatches updateUI
 *
 * Edge-triggered: only fires expansion at false→true transitions, not while condition stays true.
 * Batch processing: all plugins processed in one pass, single updateUI call.
 *
 * Manual override:
 * - User manually closing a drawer → adds to `autoRevealDismissed` (suppresses future auto-reveal)
 * - User manually opening a drawer → removes from `autoRevealDismissed` AND from internal
 *   `autoOpenedIds` (suppresses future auto-collapse, since it wasn't system-opened)
 * - Auto-collapse only applies to drawers that were auto-opened by this engine.
 */
export function useDrawerReveal(
  revealPlugins: BuiltPlugin[],
  state: EditorState,
  actions: EditorActions,
) {
  const prevConditions = useRef<Record<string, boolean>>({});

  /**
   * Tracks which drawers were opened BY the auto-reveal system (not by user).
   * Auto-collapse (`collapseWhenFalse`) only fires for drawers in this set.
   * When user manually opens a drawer, it is NOT in this set → immune to auto-collapse.
   */
  const autoOpenedIds = useRef<Set<string>>(new Set());

  // Step 1: Compute all condition results — only re-evaluates when relevant state slices change
  const conditionResults = useMemo(() => {
    const results: Record<string, boolean> = {};
    for (const plugin of revealPlugins) {
      const rule = plugin.autoReveal;
      if (!rule?.when) continue;
      results[plugin.uid] = rule.when(state);
    }
    return results;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    revealPlugins,
    state.activeFrameId,
    state.frames,
    state.interaction.signals,
    state.ui.activeSidebarIds,
  ]);

  // Step 2: Edge detection + dispatch — only fires when conditionResults reference changes
  useEffect(() => {
    const currentIds = state.ui.activeSidebarIds || [];
    const dismissed = state.ui.autoRevealDismissed || [];
    let nextIds = [...currentIds];
    let changed = false;

    for (const plugin of revealPlugins) {
      const shouldShow = conditionResults[plugin.uid] ?? false;
      const wasShowing = prevConditions.current[plugin.uid] ?? false;
      const isDismissed = dismissed.includes(plugin.uid);
      const isAlreadyActive = currentIds.includes(plugin.uid);

      // Edge trigger: condition false → true
      if (shouldShow && !wasShowing && !isDismissed && !isAlreadyActive) {
        nextIds.push(plugin.uid);
        autoOpenedIds.current.add(plugin.uid);
        changed = true;
      }

      // Optional: condition true → false auto-collapse
      // ONLY collapses drawers that were auto-opened (not manually opened by user)
      const rule = plugin.autoReveal!;
      if (
        !shouldShow && wasShowing &&
        rule.collapseWhenFalse &&
        isAlreadyActive &&
        autoOpenedIds.current.has(plugin.uid)
      ) {
        nextIds = nextIds.filter(id => id !== plugin.uid);
        autoOpenedIds.current.delete(plugin.uid);
        changed = true;
      }

      prevConditions.current[plugin.uid] = shouldShow;
    }

    if (changed) {
      actions.updateUI({ activeSidebarIds: nextIds });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conditionResults, state.ui.autoRevealDismissed]);

  // Step 3: Reset dismissed list when active frame changes (new context = fresh start)
  const prevFrameId = useRef(state.activeFrameId);
  useEffect(() => {
    if (state.activeFrameId !== prevFrameId.current) {
      prevFrameId.current = state.activeFrameId;
      autoOpenedIds.current.clear();
      if (state.ui.autoRevealDismissed && state.ui.autoRevealDismissed.length > 0) {
        actions.updateUI({ autoRevealDismissed: [] });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeFrameId]);

  // Step 4: Sync autoOpenedIds when user manually interacts
  // If a drawer is in autoOpenedIds but is no longer active (user closed it externally), remove it.
  // If a drawer is active but NOT in autoOpenedIds (user manually opened it), leave it alone.
  useEffect(() => {
    const currentIds = state.ui.activeSidebarIds || [];
    for (const uid of autoOpenedIds.current) {
      if (!currentIds.includes(uid)) {
        autoOpenedIds.current.delete(uid);
      }
    }
  }, [state.ui.activeSidebarIds]);
}
