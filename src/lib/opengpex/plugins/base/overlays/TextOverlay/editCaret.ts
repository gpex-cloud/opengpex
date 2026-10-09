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
 * One-shot handoff of the pointer position that started a text edit session.
 *
 * The interaction handlers (text-place click, LayerOverlay double-click) know
 * WHERE the user clicked, but the inline editor mounts later (React effect).
 * The starter stores the viewport-space point here; the editor's init effect
 * consumes it once to drop the caret at the clicked position (via
 * caretRangeFromPoint) instead of always collapsing to the text end.
 */
export interface PendingEditCaretPoint {
  clientX: number;
  clientY: number;
}

let pending: PendingEditCaretPoint | null = null;

export function setPendingEditCaretPoint(point: PendingEditCaretPoint): void {
  pending = point;
}

export function consumePendingEditCaretPoint(): PendingEditCaretPoint | null {
  const point = pending;
  pending = null;
  return point;
}
