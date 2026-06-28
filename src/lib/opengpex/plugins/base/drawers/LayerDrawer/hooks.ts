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

import { useMemo } from 'react';
import { useEditorState, useEditorServices, usePluginCommands } from '@opengpex/editor/core/context';
import { Layer } from '@opengpex/editor/core/types';
import type { LayerCommandsMap } from './commands.d';
import { calcFullLayerStack } from './utils';

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
        maskSyncOverlayCmd
    } = usePluginCommands<LayerCommandsMap>();

    return useMemo(() => ({
        // Plugin Commands (transparently passed Cmd references)
        reorderCmd,
        removeCmd,
        visibilityCmd,
        lockCmd,
        renameCmd,
        syncOverlayCmd,
        maskSyncOverlayCmd,

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

    }), [actions, activeFrame, reorderCmd, removeCmd, visibilityCmd, lockCmd, renameCmd, syncOverlayCmd, maskSyncOverlayCmd]);
};
