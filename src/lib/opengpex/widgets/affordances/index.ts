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
 * affordances — the declarative transform-HUD framework. Consumers declare
 * their entity's anchor geometry per tick and which affordances are on
 * (gizmo / dimension chip / action bar); the framework owns the rotated
 * container sync (descaled matrix), the rotated label-row layout with
 * right-align hysteresis and the hover-reveal machinery. Business-free:
 * every per-frame fact arrives through providers, never entity internals.
 */
export { TransformHud } from './TransformHud';
export { useHudAnchorSync } from './useHudAnchorSync';
export { useHudLabelRow } from './useHudLabelRow';
export type { HudTickArgs, TransformHudProps } from './types';
export type { HudRevealMode } from './useHudAnchorSync';
export type { HudLabelRowOptions, HudLabelRowRefs } from './useHudLabelRow';
