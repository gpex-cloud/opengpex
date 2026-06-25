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

// ToolMenu.styles.ts
import { EDITOR_Z_INDEX } from '@opengpex/editor/core/helpers/config';

/**
 * ToolMenu style generator.
 */
export const getToolMenuStyles = (isCollapsed: boolean, isPinned: boolean = false) => {
    return {
        // Main shell (floating mode vs pinned mode)
        container: {
            className: `
                relative flex flex-col transition-all duration-300 overflow-visible
                ${isPinned
                    ? 'w-full h-full rounded-none border-none shadow-none bg-transparent'
                    : `bg-[var(--bg-panel)]/40 backdrop-blur-3xl border border-[var(--border-subtle)] shadow-[0_8px_32px_0_rgba(0,0,0,0.12)] rounded-xl
                       ${!isCollapsed ? 'w-[280px] h-auto rounded-2xl' : 'w-[34px] h-[34px]'}`
                }
            `
        },
        // Top Logo bar
        header: {
            className: isPinned
                ? "flex flex-col items-center w-full shrink-0 pt-2 pb-1 gap-2"
                : `flex items-center w-full shrink-0 transition-all duration-300
                   ${!isCollapsed ? "h-[48px] justify-start pl-[9px] pr-3 gap-3" : "h-[34px] justify-center"}`
        },
        // Logo trigger button
        trigger: {
            className: `
                flex items-center justify-center shrink-0 transition-all duration-300
                outline-none focus:outline-none focus:ring-0 select-none cursor-pointer
                w-[34px] h-[34px] rounded-xl hover:bg-[var(--bg-panel)]/40 active:scale-90
            `
        },
        // ✨ Globally unified high-precision divider
        divider: {
            className: "h-px self-stretch bg-[var(--border-subtle)] mx-2 my-0.5 shrink-0"
        },
        // ✨ Pure menu sub-panel container
        subMenuPanel: {
            className: `
                absolute left-full top-0 ml-2 w-[240px] flex flex-col gap-0.5 py-2
                bg-[var(--bg-panel)]/90 backdrop-blur-3xl border border-[var(--border-subtle)]
                rounded-2xl shadow-[0_10px_30px_rgba(0,0,0,0.2)]
                animate-in fade-in slide-in-from-left-2 duration-200
            `,
            style: { zIndex: EDITOR_Z_INDEX?.UI?.POPOVER ? EDITOR_Z_INDEX.UI.POPOVER + 5 : 999 }
        },
        // ✨ Native atomic menu item
        menuItem: {
            button: `
                group relative flex items-center w-full h-[30px] rounded-lg
                bg-transparent hover:bg-[var(--bg-stage)] border-none
                transition-all duration-200 cursor-pointer outline-none
                ${isPinned ? 'justify-center px-0' : 'px-3 gap-3 text-left'}
            `,
            icon: "w-4 h-4 flex items-center justify-center shrink-0 text-[var(--text-muted)] group-hover:text-[var(--text-main)] transition-colors",
            label: `flex-1 text-[12px] font-medium text-[var(--text-main)] normal-case whitespace-nowrap ${isPinned ? 'hidden' : ''}`,
            shortcut: `text-[10px] font-black text-[var(--text-muted)] uppercase tracking-tighter opacity-60 ${isPinned ? 'hidden' : ''}`
        },
        // Legacy quarantine area: specially dedicated to fixing layout of externally injected components (FunctionButton + internal Divider)
        pluginSlotWrapper: {
            className: `
                flex flex-col px-2 gap-0
                
                /* 1. Basic typography and gap erasing */
                [&_div:not(.slot-divider)]:!flex [&_div:not(.slot-divider)]:!flex-col [&_div:not(.slot-divider)]:!w-full [&_div:not(.slot-divider)]:!items-stretch [&_div:not(.slot-divider)]:!gap-0 [&_div:not(.slot-divider)]:!p-0 [&_div:not(.slot-divider)]:!m-0
                [&_.slot-divider]:!w-auto [&_.slot-divider]:!self-stretch [&_.slot-divider]:!mx-0 [&_.slot-divider]:!my-1 [&_.slot-divider]:!h-[1px] [&_.slot-divider]:!min-h-[1px] [&_.slot-divider]:!shrink-0 [&_.slot-divider]:!bg-[var(--border-subtle)] [&_.slot-divider]:!block
                
                /* 2. Strict button form shield (30px ultra-compact version) */
                [&_button]:!flex [&_button]:!items-center [&_button]:!justify-start [&_button]:!w-full [&_button]:!h-[30px] [&_button]:!px-3 [&_button]:!gap-3 [&_button]:!m-0
                [&_button]:!bg-transparent [&_button]:!border-none [&_button]:!shadow-none [&_button]:!rounded-lg
                [&_button:hover]:!bg-[var(--bg-stage)]
                
                /* 3. Basic silent colors for text and icons */
                [&_button]:after:content-[attr(data-label)] [&_button]:after:text-[12px] [&_button]:after:font-medium [&_button]:after:text-[var(--text-main)] [&_button]:after:flex-1 [&_button]:after:text-left [&_button]:after:normal-case [&_button]:after:whitespace-nowrap [&_button]:after:order-2
                [&_button]:before:content-[attr(data-shortcut)] [&_button]:before:text-[10px] [&_button]:before:font-black [&_button]:before:text-[var(--text-muted)] [&_button]:before:uppercase [&_button]:before:tracking-tighter [&_button]:before:opacity-60 [&_button]:before:order-3
                [&_svg]:!w-4 [&_svg]:!h-4 [&_svg]:!shrink-0 [&_svg]:!text-[var(--text-muted)]

                /* 🌟 4. Amber highlight exception */
                
                /* --- Make icon amber --- */
                [&_button.active_svg]:!text-amber-500
                [&_button[data-active="true"]_svg]:!text-amber-500
                [&_button[data-state="on"]_svg]:!text-amber-500
                [&_button[aria-pressed="true"]_svg]:!text-amber-500

                /* --- Make text amber as well --- */
                [&_button.active]:after:!text-amber-500
                [&_button[data-active="true"]]:after:!text-amber-500
                [&_button[data-state="on"]]:after:!text-amber-500
                [&_button[aria-pressed="true"]]:after:!text-amber-500
            `
        },
        topLevelPluginSlotWrapper: {
            className: `
                flex flex-col px-2 gap-0
                
                /* 1. Basic typography and gap erasing */
                [&_div:not(.slot-divider)]:!flex [&_div:not(.slot-divider)]:!flex-col [&_div:not(.slot-divider)]:!w-full [&_div:not(.slot-divider)]:!items-stretch [&_div:not(.slot-divider)]:!gap-0 [&_div:not(.slot-divider)]:!p-0 [&_div:not(.slot-divider)]:!m-0
                [&_.slot-divider]:!w-auto [&_.slot-divider]:!self-stretch [&_.slot-divider]:!mx-0 [&_.slot-divider]:!my-1 [&_.slot-divider]:!h-[1px] [&_.slot-divider]:!min-h-[1px] [&_.slot-divider]:!shrink-0 [&_.slot-divider]:!bg-[var(--border-subtle)] [&_.slot-divider]:!block
                
                /* 2. Strict button form shield (30px ultra-compact version) */
                [&_button]:!flex [&_button]:!items-center [&_button]:!w-full [&_button]:!h-[30px] [&_button]:!m-0
                [&_button]:!bg-transparent [&_button]:!border-none [&_button]:!shadow-none [&_button]:!rounded-lg
                [&_button:hover]:!bg-[var(--bg-stage)]
                
                /* 3. Basic silent colors for text and icons */
                [&_svg]:!w-4 [&_svg]:!h-4 [&_svg]:!shrink-0 [&_svg]:!text-[var(--text-muted)]

                /* 🌟 4. Amber highlight exception */
                
                /* --- Make icon amber --- */
                [&_button.active_svg]:!text-amber-500
                [&_button[data-active="true"]_svg]:!text-amber-500
                [&_button[data-state="on"]_svg]:!text-amber-500
                [&_button[aria-pressed="true"]_svg]:!text-amber-500

                /* --- Make text amber as well --- */
                [&_button.active]:after:!text-amber-500
                [&_button[data-active="true"]]:after:!text-amber-500
                [&_button[data-state="on"]]:after:!text-amber-500
                [&_button[aria-pressed="true"]]:after:!text-amber-500

                ${isPinned
                    ? `
                    [&_button]:!justify-center [&_button]:!px-0
                    [&_button]:after:!hidden [&_button]:before:!hidden
                    `
                    : `
                    [&_button]:!justify-start [&_button]:!px-3 [&_button]:!gap-3
                    [&_button]:after:content-[attr(data-label)] [&_button]:after:text-[12px] [&_button]:after:font-medium [&_button]:after:text-[var(--text-main)] [&_button]:after:flex-1 [&_button]:after:text-left [&_button]:after:normal-case [&_button]:after:whitespace-nowrap [&_button]:after:order-2
                    [&_button]:before:content-[attr(data-shortcut)] [&_button]:before:text-[10px] [&_button]:before:font-black [&_button]:before:text-[var(--text-muted)] [&_button]:before:uppercase [&_button]:before:tracking-tighter [&_button]:before:opacity-60 [&_button]:before:order-3
                    `
                }
            `
        }
    };
};
