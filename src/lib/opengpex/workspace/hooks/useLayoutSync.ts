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

import { useLayoutEffect } from 'react';
import { EditorData, EditorActions } from '@opengpex/editor/core/types';
import { getWorkspaceLayout } from '../Workspace.styles';

/**
 * useLayoutSync: Layout auto sync hook
 * Responsible for syncing current layout config (margins) to Redux State.
 */
export function useLayoutSync(state: EditorData, actions: EditorActions) {
    const { ui: { theme }, isLoaded } = state;

    useLayoutEffect(() => {
        // [FIX] Skip layout sync during BOOTING phase to prevent updateUI from triggering
        // unnecessary re-renders that cause FancyOverlay to flash/re-animate.
        if (!isLoaded) return;

        const layout = getWorkspaceLayout();

        const targetInsets = layout.offsets;
        const currentInsets = theme.config.insets;

        // Precise comparison to avoid expensive JSON.stringify
        const isChanged =
            targetInsets.top !== currentInsets.top ||
            targetInsets.left !== currentInsets.left ||
            targetInsets.right !== currentInsets.right ||
            targetInsets.bottom !== currentInsets.bottom;

        if (isChanged) {
            actions.updateUI({
                theme: {
                    active: theme.active,
                    config: {
                        insets: targetInsets
                    }
                }
            });
        }
    }, [theme.active, theme.config.insets, actions, isLoaded]);

}
