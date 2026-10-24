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
 * Pen tool interaction surface — the pointer gestures and the tool state they
 * share, split one file per handler over a common `shared.ts`.
 *
 * Priority arbitration (highest test wins):
 * - pen-dblclick-activate (175): pan-mode double-click on a pen layer enters
 *   the tool with that layer selected (pan mode only).
 * - pen-rotate (166) / pen-resize (165): gizmo handle gestures on the active
 *   pen layer (rotate rides the layer channel; resize bakes into penData).
 * - pen-move (162): drag inside a pen layer's visible shape moves the whole
 *   layer; Cmd/Ctrl extends the move onto the path geometry itself.
 * - pen-edit (160): drag/insert anchors on committed pen paths (yields while
 *   a draft session is alive).
 * - pen-draw (145): place anchors into the draft session (ignores meta
 *   presses — Cmd/Ctrl belongs to the transform surface).
 */

export * from './shared';
export { createPenDblClickActivateHandler } from './activate';
export { createPenDrawHandler } from './draw';
export { createPenEditHandler } from './edit';
export { createPenMoveHandler } from './move';
export { createPenResizeHandler } from './resize';
export { createPenRotateHandler } from './rotate';
