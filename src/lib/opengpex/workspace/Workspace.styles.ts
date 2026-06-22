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

import React from 'react';
import { EDITOR_Z_INDEX } from '@opengpex/editor/core/helpers/config';

/**
 * Workspace Geometry Configuration: Single source of truth for layout dimensions.
 */
export const WORKSPACE_GEOMETRY = {
    TOOLBAR_WIDTH: 40,
    SIDEBAR_WIDTH: 320,
    DRAWER_BAR_WIDTH: 40,
    HEADER_HEIGHT: 48,
    TOOL_MENU_WIDTH: 48,
};

// [REFACTOR-Step2] `getWorkspaceLayout()` (and its `offsets` field) was the static
// constant feed for `useLayoutSync`. Now that `useLayoutSync` derives insets from
// the dynamic `LayoutContext.safeRect`, this helper is no longer consumed and has
// been removed. Geometry constants remain in `WORKSPACE_GEOMETRY`.

export interface WorkspaceStyleItem {
    className: string;
    style?: React.CSSProperties;
}

/**
 * Workspace Styles: Decouples layout ClassNames from the main component logic.
 */
export const getWorkspaceStyles = (
    hasSidebar: boolean = true,
    insets: { top: number; left: number; right: number; bottom: number } = { top: 0, left: 0, right: 0, bottom: 0 },
    isToolMenuPinned: boolean = false
): Record<string, WorkspaceStyleItem> => {
    void hasSidebar;
    const { SIDEBAR_WIDTH } = WORKSPACE_GEOMETRY;

    return {
        // Top-level layout container
        root: {
            className: "relative flex h-full w-full bg-[var(--bg-panel)] text-[var(--text-main)] font-sans overflow-hidden select-none",
            style: {
                '--v-offset-top': `${insets.top}px`,
                '--v-offset-left': `${insets.left}px`,
                '--v-offset-right': `${insets.right}px`,
                '--v-offset-bottom': `${insets.bottom}px`,
            } as React.CSSProperties
        },

        // Middle container that holds TopBar and Stage
        midContainer: {
            className: `flex-1 relative flex flex-col overflow-hidden bg-transparent`
        },

        // Top Bar Layout Wrapper
        topBarOuter: {
            className: `absolute top-0 left-[var(--v-offset-left)] right-[var(--v-offset-right)] border-transparent pointer-events-none flex items-center justify-center transition-all duration-500`,
            style: {
                zIndex: EDITOR_Z_INDEX.UI.WORKSPACE_BASE + 5,
                height: `${WORKSPACE_GEOMETRY.HEADER_HEIGHT}px`
            }
        },

        // The actual Pill bar content container
        topBarInner: {
            className: `flex items-center transition-all duration-700 h-[34px] animate-in fade-in slide-in-from-top-4`
        },

        // Stage Area Container
        stageWrapper: {
            // [FIX] Removed 'transition-all' to ensure instant size updates when ToolMenu pins/unpins.
            // This prevents the stability timer in LayoutProvider from measuring transitioning/incorrect dimensions.
            className: `relative overflow-hidden bg-[var(--bg-stage)] h-full`
        },

        // --- Tool Menu ---
        toolMenu: {
            className: isToolMenuPinned
                ? `relative pointer-events-auto transition-all duration-300 h-full shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-panel)]/40 backdrop-blur-3xl shadow-[4px_0_24px_rgba(0,0,0,0.05)]`
                : `absolute pointer-events-auto transition-all duration-300 left-[11px] top-2`,
            style: {
                zIndex: EDITOR_Z_INDEX.UI.POPOVER + 5,
                width: isToolMenuPinned ? `${WORKSPACE_GEOMETRY.TOOL_MENU_WIDTH}px` : undefined,
            }
        },

        xtendButton: {
            className: `absolute pointer-events-auto transition-all duration-300 right-[11px] top-2`,
            style: {
                zIndex: EDITOR_Z_INDEX.UI.POPOVER + 5
            }
        },

        // --- Drawer Bar ---
        drawerBar: {
            className: `shrink-0 flex flex-col items-center gap-0 absolute top-2 bottom-4 pt-0 pb-0 px-0 pointer-events-none transition-all duration-500`,
            style: {
                zIndex: EDITOR_Z_INDEX.UI.OVERLAY,
                width: `${WORKSPACE_GEOMETRY.DRAWER_BAR_WIDTH}px`
            }
        },

        drawerBarHeaderItem: {
            className: `flex items-center justify-center transition-all duration-300 outline-none focus:outline-none focus:ring-0 select-none w-[34px] h-[34px] rounded-xl bg-[var(--bg-panel)]/40 backdrop-blur-3xl border border-[var(--border-subtle)] shadow-[0_8px_32px_0_rgba(0,0,0,0.12)] hover:bg-[var(--bg-panel)]/60 active:scale-95 pointer-events-auto cursor-pointer`
        },

        drawerBarItem: {
            className: `relative flex items-center justify-center transition-all duration-300 cursor-pointer active:scale-95 [&_svg]:!w-5 [&_svg]:!h-5 w-[34px] h-[34px] rounded-xl bg-[var(--bg-panel)]/80 backdrop-blur-3xl border border-[var(--border-subtle)] shadow-xl pointer-events-auto`
        },

        drawerBarItemActive: {
            className: 'bg-indigo-500/80 text-white ring-2 ring-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.5)]'
        },

        drawerBarFooterItem: {
            className: `flex items-center justify-center transition-all duration-300 outline-none focus:outline-none focus:ring-0 select-none w-[34px] h-[34px] rounded-xl bg-[var(--bg-panel)]/40 backdrop-blur-3xl border border-[var(--border-subtle)] shadow-[0_8px_32px_0_rgba(0,0,0,0.12)] hover:bg-[var(--bg-panel)]/60 active:scale-95 pointer-events-auto cursor-pointer`
        },

        // Sidebar Container
        sidebar: {
            className: `shrink-0 h-full flex flex-col transition-all duration-700 animate-in slide-in-from-right absolute right-0 top-0 bottom-0 bg-[var(--bg-panel)]/40 backdrop-blur-lg backdrop-saturate-200 rounded-none border-l border-[var(--border-subtle)] shadow-[-8px_0_32px_0_rgba(0,0,0,0.12)] z-[100]`,
            style: { width: `${SIDEBAR_WIDTH}px` }
        },

        // Floating Panel Mode
        sidebarFloating: {
            className: `relative w-[320px] h-auto max-h-[calc(100vh-120px)] overflow-hidden bg-[var(--bg-panel)]/90 backdrop-blur-3xl backdrop-saturate-200 shadow-2xl z-[900] rounded-[20px] border border-[var(--border-subtle)]`,
            style: {}
        },

        sidebarInner: {
            className: `flex-1 flex flex-col overflow-y-auto scrollbar-hide pointer-events-auto px-1 pt-3 pb-2 gap-2`
        },

        // Viewport-aware UI overlay container
        stageUIOverlay: {
            className: `absolute inset-0 pointer-events-none overflow-hidden transition-all duration-500`
        }
    };
};
