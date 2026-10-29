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

import { useCallback, useMemo } from 'react';
import {
  useEditorServices,
  useEditorState,
  usePluginCommands,
  usePluginSignals,
  usePluginSelfConfig,
} from '@opengpex/editor/core/context';
import type { GradeCategory, GradeState } from '@opengpex/editor/core/types';
import type { AdjustmentDrawerCommandsMap, AdjustmentDrawerSignalsMap } from '../commands.d';
import type { ActiveGradingTool, GradingTool, AdjustmentDrawerConfig } from '../protocols';
import { DEFAULT_GRADING_TOOL } from '../protocols';
import { resolveEditableTail } from '../utils-hotTail';

const EMPTY_GRADE: GradeState = {};

// ─── useHotTailGrade ─────────────────────────────────────────────────────────

/**
 * useHotTailGrade — the grade a panel of `category` should display and edit.
 *
 * `grade` is the EDITABLE hot tail's parameter bundle (see `utils-hotTail.ts`):
 * the chain's last mask when it is enabled, of this category, and its
 * coverage matches the current selection — otherwise an empty bundle, which
 * the panel renders as its defaults (cold start: the next write appends a
 * new mask). `committedCount` is how many masks of this category the layer
 * already carries, so the panel can tell the user that earlier steps exist
 * in the chain (their values cannot be folded into one slider — the
 * composition of two brightness curves is not a brightness curve).
 */
export function useHotTailGrade(category: GradeCategory): {
  grade: GradeState;
  tailId: string | undefined;
  committedCount: number;
} {
  const { activeFrame, activeLayer } = useEditorState();
  const { geometry } = useEditorServices();
  return useMemo(() => {
    if (!activeFrame || !activeLayer) return { grade: EMPTY_GRADE, tailId: undefined, committedCount: 0 };
    const tail = resolveEditableTail(geometry, activeFrame, activeLayer, category);
    const committedCount = (activeLayer.adjustMasks ?? []).filter((m) => m.category === category).length;
    return { grade: tail?.grade ?? EMPTY_GRADE, tailId: tail?.id, committedCount };
  }, [activeFrame, activeLayer, geometry, category]);
}


// ─── useAdjustmentDrawer ─────────────────────────────────────────────────────

/**
 * useAdjustmentDrawer — semantic hook for the drawer's main body.
 *
 * Returns the currently active grading tool + a few convenience flags derived
 * from the active layer's grading state. The panel body uses these to decide
 * which sub-panel to render and whether to show "no active layer" placeholders.
 *
 * The active tool is resolved with a three-level fallback (in priority order):
 *   1. The live `activeGradingToolSignal` value (if user has interacted this session)
 *   2. `pluginConfig.lastTool` (persisted across sessions)
 *   3. `DEFAULT_GRADING_TOOL` (`'curves'` — matches Photoshop's Curves default)
 */
export function useAdjustmentDrawer() {
  const { activeGradingToolSignal } = usePluginSignals<AdjustmentDrawerSignalsMap>();
  const [selfConfig] = usePluginSelfConfig<AdjustmentDrawerConfig>();
  const { activeLayer } = useEditorState();

  const activeTool: ActiveGradingTool =
    (activeGradingToolSignal?.value as ActiveGradingTool | undefined) ??
    selfConfig?.lastTool ??
    DEFAULT_GRADING_TOOL;

  return {
    activeTool,
    activeLayer,
  };
}


// ─── useGradingToolSwitch ──────────────────────────────────────────────────────

/**
 * useGradingToolSwitch — semantic hook for the header icon-button group.
 *
 * Encapsulates the switch command + the currently active tool identity.
 */
export function useGradingToolSwitch() {
  const { setGradingToolCmd } = usePluginCommands<AdjustmentDrawerCommandsMap>();
  const { activeTool } = useAdjustmentDrawer();

  const selectTool = useCallback(
    (tool: GradingTool) => {
      setGradingToolCmd?.execute({ tool });
    },
    [setGradingToolCmd]
  );

  return useMemo(
    () => ({ activeTool, selectTool }),
    [activeTool, selectTool]
  );
}
