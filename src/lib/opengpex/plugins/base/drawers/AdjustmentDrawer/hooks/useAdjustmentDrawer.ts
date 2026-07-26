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
  useEditorState,
  usePluginCommands,
  usePluginSignals,
  usePluginSelfConfig,
} from '@opengpex/editor/core/context';
import type { AdjustmentDrawerCommandsMap, AdjustmentDrawerSignalsMap } from '../commands.d';
import type { ActiveGradingTool, GradingTool, AdjustmentDrawerConfig } from '../protocols';
import { DEFAULT_GRADING_TOOL } from '../protocols';


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
