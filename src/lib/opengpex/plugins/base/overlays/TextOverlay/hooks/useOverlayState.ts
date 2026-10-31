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

import { useEffect } from 'react';
import { useEditorState, useEditorServices } from '@opengpex/editor/core/context';
import { CraftDrawerAPI } from '../../../drawers/CraftDrawer/protocols';
import { TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID } from '../protocols';
import { TEXT_PREEDIT_CURSOR } from '@opengpex/editor/icons';

// ─── useTextOverlayState ───────────────────────────────────────────────────────

/**
 * useTextOverlayState: TextOverlay main component state Hook
 *
 * Reads activeCraft and editingLayerId signals, handling layer validity check and Escape exit logic.
 * Returns core judgment data required for rendering.
 */
export function useTextOverlayState() {
  const { state, activeFrame } = useEditorState();
  const { actions } = useEditorServices();

  const activeCraft = state.interaction.signals[CraftDrawerAPI.signals.activeCraft];
  const editingLayerId = state.interaction.signals[TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID] as string | null;

  // Detect if the layer pointed by signal is still valid
  const layerExists = !!(editingLayerId && activeFrame?.layers.byId[editingLayerId]?.type === 'text');

  useEffect(() => {
    if (editingLayerId && !layerExists) {
      actions.setStateSignal(TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, null);
    }
  }, [editingLayerId, layerExists, actions]);

  // Escape in pre-edit state -> exits craft mode (via CraftDrawer's deactivate command, following cross-plugin boundaries)
  useEffect(() => {
    if (activeCraft !== 'text' || editingLayerId) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // Deactivate tool via CraftDrawer's command system (following signal ownership boundaries)
        actions.executeCommand(CraftDrawerAPI.commands.deactivate.uid);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [activeCraft, editingLayerId, actions]);

  // Pre-edit cursor: the text tool registers its pre-edit cursor as a plain
  // base cursor — NO hover affordance. Moving an existing text layer requires
  // the Cmd spring key (TextMoveHandler's pre-edit branch is gated to it), so
  // the pointer keeps the tool cursor whether or not it is over a text box.
  // Live editing session: the contenteditable owns the cursor (its base
  // 'text' comes from the element itself; Cmd shows the spring-key move
  // cursor through the global-cursor rule), so nothing is registered.
  useEffect(() => {
    if (activeCraft !== 'text' || !activeFrame || editingLayerId) return;
    actions.fast.cursor.register('text', TEXT_PREEDIT_CURSOR);
    return () => {
      actions.fast.cursor.register('text', null);
    };
  }, [activeCraft, editingLayerId, activeFrame, actions]);

  return {
    activeFrame,
    activeCraft,
    editingLayerId,
    layerExists,
  };
}
