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
 * Volatile fast-track types.
 *
 * Per refactor decision D1(b): the canonical type declarations live in the
 * global type aggregation point `core/types/state.ts`. This module simply
 * re-exports them so that everything under `core/state/volatile/` can import
 * its types from a single local entry point.
 */
export type {
  VolatileState,
  VolatileInteraction,
  VolatileStateHandle,
} from '@opengpex/editor/core/types';
