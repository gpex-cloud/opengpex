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
 * TextCaretKit: self-contained custom caret toolkit for contenteditable hosts.
 *
 * - geometry.ts: pure DOM measurement/projection/placement (unit-testable).
 * - useCaretAnchor: React hook tracking the caret as a container-local anchor.
 * - TextCaret: render-only caret bar (blink, counter-scaled screen-constant).
 *
 * Host contract: the host owns the container transform (live, may be written
 * by a ticker) and a counter-scale CSS variable (default `--text-caret-scale`,
 * value = 1 / camera scale). Everything else is the kit's job.
 */

export * from './geometry';
export * from './useCaretAnchor';
export * from './Caret';
export * from './useSelectionRects';
export * from './Selection';
