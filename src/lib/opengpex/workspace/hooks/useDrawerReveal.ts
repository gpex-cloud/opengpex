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
 * Design principles:
 * 1. Edge-triggered: only acts on condition transitions, not steady state.
 * 2. Two modes determined by `collapseWhenFalse`:
 *    - Contextual (collapseWhenFalse: true): Drawer follows condition lifecycle.
 *      Opens on false→true, closes on true→false. Always.
 *    - Sticky (collapseWhenFalse: false): Drawer auto-opens on false→true,
 *      but never auto-closes. User controls closing.
 * 3. First-render immunity: On mount, conditions are seeded without triggering edges.
 *    This prevents persisted state from causing spurious opens on page refresh.
 *
 * Performance:
 * - useMemo computes conditions from minimal state slices (not the full state object).
 * - useEffect only fires when the memo result reference changes.
 * - Single updateUI call per batch.
 */
export function useDrawerReveal(
  revealPlugins: BuiltPlugin[],
  state: EditorState,
  actions: EditorActions,
) {
  const prevConditions = useRef<Record<string, boolean>>({});
  /** 首次渲染时建立基线，之后才开始边沿检测 */
  const isInitialized = useRef(false);

  // Compute all condition results — only re-evaluates when relevant state slices change
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

  // Edge detection + dispatch
  useEffect(() => {
    // 首次渲染：用当前状态建立基线，不触发任何动作。
    // 防止 localStorage 恢复的持久信号在刷新时导致误弹出。
    if (!isInitialized.current) {
      isInitialized.current = true;
      for (const plugin of revealPlugins) {
        prevConditions.current[plugin.uid] = conditionResults[plugin.uid] ?? false;
      }
      return;
    }

    const currentIds = state.ui.activeSidebarIds || [];
    let nextIds = [...currentIds];
    let changed = false;

    for (const plugin of revealPlugins) {
      const shouldShow = conditionResults[plugin.uid] ?? false;
      const wasShowing = prevConditions.current[plugin.uid] ?? false;
      const isActive = currentIds.includes(plugin.uid);
      const rule = plugin.autoReveal!;

      if (shouldShow && !wasShowing && !isActive) {
        // Edge false→true, drawer not open → open it
        nextIds.push(plugin.uid);
        changed = true;
      } else if (!shouldShow && wasShowing && isActive && rule.collapseWhenFalse) {
        // Edge true→false, drawer open, contextual mode → close it
        nextIds = nextIds.filter(id => id !== plugin.uid);
        changed = true;
      }

      prevConditions.current[plugin.uid] = shouldShow;
    }

    if (changed) {
      actions.updateUI({ activeSidebarIds: nextIds });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conditionResults]);
}
