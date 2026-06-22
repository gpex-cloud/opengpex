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

import { useEffect, useRef } from 'react';
import {
    useEditorServices,
    useEditorState,
} from '@opengpex/editor/core/context';
import { useLayout } from '../LayoutContext';

/**
 * useLayoutSync: Single-source-of-truth bridge from LayoutContext to Redux.
 *
 * [REFACTOR-Step2] Switched from "static constants → Redux" to
 * "dynamic safeRect → Redux insets" so that command-side consumers
 * (fit / actualSize / zoomBy) read the same authoritative insets that
 * the viewport-side consumer (useCameraInit, via Context) already sees.
 *
 * Sync rules:
 *  - Only writes when `status === 'STABLE'` to avoid intermediate
 *    measurements during MEASURING transitions.
 *  - Skips during BOOTING phase (FancyOverlay anti-flicker).
 *  - Uses ref to read current insets without re-triggering the effect
 *    when its own dispatch updates Redux (prevents render dead-loops).
 *  - Performs precise field comparison to elide redundant dispatches.
 *
 * MUST be called inside a `<LayoutProvider>` subtree.
 */
export function useLayoutSync() {
    const { state } = useEditorState();
    const { actions } = useEditorServices();
    const { safeRect, status } = useLayout();

    const { isLoaded, ui } = state;
    const { theme, viewportDim } = ui;

    // Snapshot ref of current insets so the effect doesn't re-fire
    // when our own dispatch causes Redux to emit a new state.
    const currentInsetsRef = useRef(theme.config.insets);
    currentInsetsRef.current = theme.config.insets;

    useEffect(() => {
        if (!isLoaded) return;
        if (status !== 'STABLE') return;
        if (viewportDim.w <= 0 || viewportDim.h <= 0) return;

        const targetInsets = {
            top: Math.max(0, Math.round(safeRect.y)),
            left: Math.max(0, Math.round(safeRect.x)),
            right: Math.max(0, Math.round(viewportDim.w - safeRect.w - safeRect.x)),
            bottom: Math.max(0, Math.round(viewportDim.h - safeRect.h - safeRect.y)),
        };

        const current = currentInsetsRef.current;
        const isChanged =
            targetInsets.top !== current.top ||
            targetInsets.left !== current.left ||
            targetInsets.right !== current.right ||
            targetInsets.bottom !== current.bottom;

        if (!isChanged) return;

        actions.updateUI({
            theme: {
                active: theme.active,
                config: { insets: targetInsets },
            },
        });
    }, [
        isLoaded,
        status,
        safeRect.x,
        safeRect.y,
        safeRect.w,
        safeRect.h,
        viewportDim.w,
        viewportDim.h,
        theme.active,
        actions,
    ]);
}
