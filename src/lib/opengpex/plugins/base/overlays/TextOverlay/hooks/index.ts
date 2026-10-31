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
 * TextOverlay hooks — barrel export.
 *
 * Split into focused modules:
 * - useOverlayState: overlay-wide render state (active craft, editing signal
 *   validity, Escape exit, pre-edit cursor registration)
 * - useInlineTextEditing: the inline editing session hook — session lifecycle
 *   (create/modify), contenteditable DOM binding, live bounding measurement,
 *   commit/cancel with undo semantics
 * - useFastSync: camera-synced fast-track positioning hooks for the editing
 *   box and the pre-edit frame
 *
 * Cross-module consumers (commands, interactions, CraftDrawer) import the
 * focused sub-paths directly instead of this barrel, so the dependency graph
 * stays acyclic as policy modules land here.
 */

export { useInlineTextEditing } from './useInlineTextEditing';
export { useTextOverlayState } from './useOverlayState';
export { getEditorMeasureContext, measureEditorBox, measureTextBounding } from './measuring';
export { isSessionDirty } from './session';
export { affectsTextStyleLayout, DEFAULT_TEXT_STYLE, pickStyleFields, TEXT_DEFAULT_LINE_HEIGHT, TEXT_STYLE_DEFAULTS, TEXT_STYLE_FIELDS } from './styling';
