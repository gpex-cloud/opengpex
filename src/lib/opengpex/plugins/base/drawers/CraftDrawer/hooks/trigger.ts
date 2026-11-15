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

import { useCallback, useEffect } from 'react';
import { usePluginCommands, usePluginSignals } from '@opengpex/editor/core/context';
import '@opengpex/editor/plugins/base/overlays/MarkerOverlay/marker';
import { ActiveCraft, CraftType } from '../protocols';
import { CraftDrawerCommandsMap, CraftDrawerSignalsMap } from '../commands.d';

// ─── useCraftTrigger ───────────────────────────────────────────────────────────

/**
 * useCraftTrigger: Semantic Hook for CraftTriggerButtons
 *
 * Encapsulates states and commands required for tool button group.
 */
export function useCraftTrigger() {
  const { setCraftCmd, cycleMarkerForwardCmd, cycleMarkerBackwardCmd } = usePluginCommands<CraftDrawerCommandsMap>();
  const { activeCraftSignal } = usePluginSignals<CraftDrawerSignalsMap>();

  const activeCraft = (activeCraftSignal?.value ?? null) as ActiveCraft;

  const selectCraft = useCallback(
    (craft: CraftType) => {
      setCraftCmd?.execute({ craft });
    },
    [setCraftCmd]
  );

  // Tab / Shift+Tab cycling over marker kinds while in marker craft mode
  useEffect(() => {
    if (activeCraft !== 'marker') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      const target = e.target as HTMLElement | null;
      const isTextInput =
        (target?.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'range') ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;
      if (isTextInput) return;

      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        cycleMarkerBackwardCmd?.execute();
      } else {
        cycleMarkerForwardCmd?.execute();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [activeCraft, cycleMarkerForwardCmd, cycleMarkerBackwardCmd]);

  return { activeCraft, selectCraft };
}

// ─── useCraftButtonGroup ───────────────────────────────────────────────────────

/**
 * useCraftButtonGroup: Semantic Hook for ButtonGroup inside CraftDrawer
 *
 * Encapsulates state and click logic of [M] [T] [B] [E] button group inside panel.
 *
 * Click rules:
 * 1. Click button of current activeCraft -> toggle off (deactivate)
 * 2. Otherwise -> activate/switch to target tool
 */
export function useCraftButtonGroup() {
  const { setCraftCmd, deactivateCraftCmd } = usePluginCommands<CraftDrawerCommandsMap>();
  const { activeCraftSignal } = usePluginSignals<CraftDrawerSignalsMap>();

  const activeCraft = (activeCraftSignal?.value ?? null) as ActiveCraft;

  const handleButtonClick = useCallback(
    (buttonType: CraftType) => {
      if (activeCraft === buttonType || (buttonType === 'eraser' && activeCraft === 'restore')) {
        // Toggle off: clicking active tool → deactivate (restore is sub-mode of eraser)
        deactivateCraftCmd?.execute();
      } else {
        // Activate or switch to target tool
        setCraftCmd?.execute({ craft: buttonType });
      }
    },
    [activeCraft, setCraftCmd, deactivateCraftCmd]
  );

  return { activeCraft, handleButtonClick };
}
