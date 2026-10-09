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
 * Interaction immunity contracts.
 *
 * Immunity = a stage-owned escape hatch that lets overlay plugins exempt
 * their own DOM from a specific stage interaction, without the stage ever
 * inspecting plugin-specific selectors. Each immunity kind is declared here
 * as an attribute constant + a target predicate; plugins opt IN by
 * declaring the attribute on their own DOM.
 *
 * Outer-canvas pan immunity:
 * The ViewportPanHandler claims any left press that lands outside the canvas
 * rect. Overlay plugins whose interactive surfaces may legitimately straddle
 * the canvas edge (e.g. the inline text editor) declare that surface with
 * {@link OUTER_CANVAS_PAN_IMMUNITY_ATTR} so those presses stay native
 * (text selection) instead of starting a pan.
 */
export const OUTER_CANVAS_PAN_IMMUNITY_ATTR = 'data-outer-canvas-pan-immunity';

/**
 * True when the event target sits inside a subtree that declared
 * {@link OUTER_CANVAS_PAN_IMMUNITY_ATTR} (checked along the ancestor chain).
 */
export const hasOuterCanvasPanImmunity = (target: EventTarget | null): boolean => {
  const el = target instanceof Element ? target : null;
  return !!el?.closest(`[${OUTER_CANVAS_PAN_IMMUNITY_ATTR}]`);
};
