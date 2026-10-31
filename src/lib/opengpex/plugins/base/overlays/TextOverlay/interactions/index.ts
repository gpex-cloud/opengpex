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

/**
 * Text tool interaction surface — the pointer gestures and the edit-session
 * handoff they share, split one file per handler over a common `shared.ts`.
 *
 * Priority arbitration (highest test wins):
 * - text-dblclick-edit (175): pan-mode double-click on a text layer activates
 *   the text tool and opens the inline editing session (pan mode only).
 * - text-move (170): pre-edit press routing for existing text layers — bare
 *   press enters editing, Cmd/Ctrl+drag moves (and selects); editing-state
 *   Cmd/Ctrl+drag keeps moving while the session stays alive.
 * - text-rotate (165): gizmo rotation-handle drag, Shift snaps to 15°.
 * - text-resize (160): gizmo handle scaling, auto-switches to fixed boxMode.
 * - text-place (150): creation on empty canvas — click = point text,
 *   drag = paragraph/fixed box; while a session runs, the first canvas click
 *   only commits it.
 */

export * from './shared';
export { createTextDblClickEditHandler } from './edit';
export { createTextMoveHandler, isTextMoveDragging } from './move';
export { createTextResizeHandler } from './resize';
export { createTextRotateHandler } from './rotate';
export { createTextPlaceHandler } from './place';
