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
 * Scratch — the plugin-owned "work path" component (sole entry point).
 *
 * Gives tools with un-landed intermediate state (pen draft today; gradient
 * editing, warp previews later) three primitives:
 *   - slots:  per-frame draft payload boxes (version-counted for repaints)
 *   - session: per-frame active-session table (begin/end arbitration)
 *   - undo/redo takeover: the funnel `actions.history` consults so that while
 *     a session is alive, global undo/redo is fenced and served from the
 *     session stack instead.
 *
 * Storage is self-held (plain maps) — NOT VolatileState, NOT Redux. Plugins
 * never import this module: they reach the service through the injected
 * `actions.scratch` facade (see useEditorStore). An ESLint no-restricted-imports
 * rule enforces the boundary for `plugins/**`.
 */

export { createSessionHistory, SESSION_HISTORY_MAX_STEPS } from './history';
export type { SessionHistory } from './history';
export { createScratchSlots } from './slots';
export type { ScratchSlots, ScratchSlotsInternal } from './slots';
export { createScratchService } from './session';
export type {
  ScratchService,
  ScratchSession,
  ActiveScratchSession,
  ScratchTakeoverResult,
} from './session';
