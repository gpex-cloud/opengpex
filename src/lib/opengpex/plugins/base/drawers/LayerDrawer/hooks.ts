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

import { useMemo, useEffect, useRef, useCallback } from 'react';
import { useEditorState, useEditorServices, usePluginCommands } from '@opengpex/editor/core/context';
import { Layer } from '@opengpex/editor/core/types';
import type { LayerDrawerCommandsMap } from './commands.d';
import { calcFullLayerStack } from './utils';
import { MASK_EDITING_KEY, type MaskEditingSignal } from './protocols';
import { CraftDrawerAPI } from '../../drawers/CraftDrawer/protocols';

/**
 * useLayerCommands: Command Discovery Hook.
 * Plugin commands are transparently passed with Cmd suffix, advanced commands are directly passed through actions.adv.layer.
 * Component layer explicitly calls .execute() and constructs payload.
 */
export const useLayerCommands = () => {
    const { activeFrame } = useEditorState();
    const { actions } = useEditorServices();
    
    const {
        reorderCmd,
        removeCmd,
        visibilityCmd,
        lockCmd,
        renameCmd,
        syncOverlayCmd,
        syncMaskCmd
    } = usePluginCommands<LayerDrawerCommandsMap>();

    return useMemo(() => ({
        // Plugin Commands (transparently passed Cmd references)
        reorderCmd,
        removeCmd,
        visibilityCmd,
        lockCmd,
        renameCmd,
        syncOverlayCmd,
        syncMaskCmd,

        // Advanced Commands (transparently passed AdvCommandRef)
        mergeDown: actions.adv.layer.merge.down,
        mergeVisible: actions.adv.layer.merge.visible,
        mergeRasterize: actions.adv.layer.merge.rasterize,
        toggleAll: actions.adv.layer.toggle.all,
        toggleOthers: actions.adv.layer.toggle.others,
        maskToggle: actions.adv.layer.mask.toggle,
        maskInvert: actions.adv.layer.mask.invert,
        maskRemove: actions.adv.layer.mask.remove,
        maskClearAll: actions.adv.layer.mask.clearAll,

        // Helpers (complex logic that needs local computation)
        reorder: (newHostLayers: Layer[]) => {
            if (!activeFrame) return;
            const fullLayers = calcFullLayerStack(newHostLayers, activeFrame.layers);
            reorderCmd?.execute({ frameId: activeFrame.id, layers: fullLayers });
        },

        // Bulk Actions — convenience wrapper for isolateSelection
        isolateSelection: () => {
            if (activeFrame?.activeLayerId) {
                actions.adv.layer.toggle.others.execute(activeFrame.activeLayerId);
            }
        },

        // Helpers
        getChildLayers: (parentId: string) => {
            if (!activeFrame) return [];
            return activeFrame.layers.order.map(id => activeFrame.layers.byId[id]).filter(l => l.parentId === parentId);
        }

    }), [actions, activeFrame, reorderCmd, removeCmd, visibilityCmd, lockCmd, renameCmd, syncOverlayCmd, syncMaskCmd]);
};

// ─── useMaskEdit ───────────────────────────────────────────────────────────────

/**
 * useMaskEdit: Mask editing mode management hook.
 *
 * Provides enterMaskEdit / exitMaskEdit helpers and monitors exit conditions
 * (Escape / tool switch / mask deletion).
 *
 * Architecture:
 * - Rendering control: purely through mask.enabled model field (engine-agnostic)
 * - UI state: via MASK_FOCUS_KEY interaction signal (only for MaskItem highlight)
 * - Tool activation: via CraftDrawer's setCraftEraser command
 */
export function useMaskEdit() {
    const { state, activeFrame } = useEditorState();
    const { actions } = useEditorServices();

    // Read current mask editing target signal
    const maskEditing = state.interaction.signals[MASK_EDITING_KEY] as MaskEditingSignal;

    // Keep a ref for maskEditing to avoid stale closures in toggle callback
    const maskEditingRef = useRef(maskEditing);
    useEffect(() => { maskEditingRef.current = maskEditing; });

    /**
     * Enter mask edit mode:
     * 1. Write MASK_EDITING_KEY signal for target mask
     * 2. Activate eraser craft tool (directly, no intermediate deactivate)
     */
    const enterMaskEdit = useCallback((layerId: string, maskId: string) => {
        if (!activeFrame) return;

        // Write editing signal + activate eraser via signal (CraftDrawer auto-sets mode='craft')
        actions.setStateSignal(MASK_EDITING_KEY, { layerId, maskId });
        actions.setStateSignal(CraftDrawerAPI.signals.activeCraft, 'eraser');
    }, [activeFrame, actions]);

    /**
     * Exit mask edit mode:
     * 1. Clear MASK_EDITING_KEY signal
     * 2. Deactivate craft tool (return to pan mode)
     * Note: No guard on maskEditing — idempotent clear is safe and avoids stale closure bugs.
     */
    const exitMaskEdit = useCallback(() => {
        if (!activeFrame) return;
        actions.setStateSignal(MASK_EDITING_KEY, null);
        // Return to pan mode (CraftDrawer will auto-clear activeCraft on mode change)
        actions.setInteraction({ interactionMode: 'pan' });
    }, [activeFrame, actions]);

    /**
     * Toggle mask edit: enters if not editing this mask, exits if already editing it.
     * Uses ref to read latest maskEditing without creating dependency → stable callback.
     */
    const toggleMaskEdit = useCallback((layerId: string, maskId: string) => {
        const current = maskEditingRef.current;
        if (current?.layerId === layerId && current?.maskId === maskId) {
            exitMaskEdit();
        } else {
            enterMaskEdit(layerId, maskId);
        }
    }, [enterMaskEdit, exitMaskEdit]);

    return { maskEditing, enterMaskEdit, exitMaskEdit, toggleMaskEdit };
}

// ─── useMaskEditMonitor ────────────────────────────────────────────────────────

/**
 * useMaskEditMonitor: Monitors exit conditions and auto-exits mask edit mode.
 *
 * Exit conditions:
 * - interactionMode leaves 'craft' (user switched to pan/clip/etc.)
 * - activeCraft changes away from 'eraser'/'restore' (user switched tool)
 * - The mask being edited is deleted
 *
 * Must be called from a component that renders when in mask edit mode.
 */
export function useMaskEditMonitor() {
    const { state, activeFrame } = useEditorState();
    const { actions } = useEditorServices();

    const maskEditing = state.interaction.signals[MASK_EDITING_KEY] as MaskEditingSignal;
    const interactionMode = state.interaction.interactionMode;
    const activeCraft = state.interaction.signals[CraftDrawerAPI.signals.activeCraft] as string | null;

    // Track previous values to detect transitions
    const prevModeRef = useRef(interactionMode);
    const prevCraftRef = useRef(activeCraft);

    useEffect(() => {
        // ALWAYS update refs to track current state (even when not editing).
        // Without this, refs go stale during non-edit periods and cause
        // false "mode changed" detection on re-entry.
        const modeChanged = prevModeRef.current !== interactionMode;
        const craftChanged = prevCraftRef.current !== activeCraft;

        prevModeRef.current = interactionMode;
        prevCraftRef.current = activeCraft;

        if (!maskEditing) return;

        // Exit condition 1: mode left 'craft'
        if (modeChanged && interactionMode !== 'craft') {
            doExit();
            return;
        }

        // Exit condition 2: craft tool changed away from eraser/restore
        if (craftChanged && activeCraft !== 'eraser' && activeCraft !== 'restore') {
            doExit();
            return;
        }

        // Exit condition 3: mask being edited no longer exists
        if (activeFrame) {
            const layer = activeFrame.layers.byId[maskEditing.layerId];
            if (!layer || !layer.bitmapMasks?.some(m => m.id === maskEditing.maskId)) {
                doExit();
                return;
            }
        }

        function doExit() {
            if (!maskEditing || !activeFrame) return;
            // Clear editing signal
            actions.setStateSignal(MASK_EDITING_KEY, null);
        }
    }, [maskEditing, interactionMode, activeCraft, activeFrame, actions]);
}
