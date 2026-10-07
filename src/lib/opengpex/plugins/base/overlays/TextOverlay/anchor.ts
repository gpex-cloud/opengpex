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
 * Align-aware centre compensation for auto-width text whose width changed
 * while typing. A text layer stores its centre (cx); when the content width
 * grows by ΔW = W_new − W_old, the centre must shift so that the visually
 * anchored edge stays put:
 *   left   → anchor the LEFT edge   → cx += ΔW / 2
 *   center → anchor the CENTRE      → cx stays
 *   right  → anchor the RIGHT edge  → cx -= ΔW / 2
 * Vertical growth always anchors the top edge (cy += ΔH / 2) for every align.
 * Axis-aligned approximation, consistent with the rest of the text overlay's
 * rect math (rotated poses get the same approximation on canvas axes).
 */

type TextAlign = 'left' | 'center' | 'right';

export function compensateCenterX(cx: number, oldW: number, newW: number, align: TextAlign | undefined): number {
  if (newW === oldW) return cx;
  const deltaW = newW - oldW;
  if (align === 'center') return cx;
  if (align === 'right') return cx - deltaW / 2;
  return cx + deltaW / 2;
}

/** Top-edge anchor for height changes (all alignments). */
export function compensateCenterY(cy: number, oldH: number, newH: number): number {
  return cy + (newH - oldH) / 2;
}

/** Live compensation base: the geometry the next compensation runs against. */
export interface CompensationBase {
  w: number;
  h: number;
  cx: number;
  cy: number;
}

/**
 * Re-anchor the compensation base after an EXTERNAL geometry change during
 * editing (Cmd/Ctrl+Drag move, gizmo resize): `base` only tracks the
 * compensations this module wrote, so without re-anchoring the next size
 * change would compute cx/cy from a stale pre-move base and visibly snap the
 * box back to where it was before the move.
 *
 * The layer's geometry is adopted ONLY when it differs from `lastObserved`
 * (the values seen on the layer at the previous notify): if it merely equals
 * what WE last wrote — our own slow-track update landing between rapid
 * notifications — adoption is a no-op anyway, and a slow-track frame that has
 * not caught up with our write yet must NOT pull the base backwards.
 * `lastObserved === null` means first call (base was just initialized from the
 * layer); nothing to compare against.
 *
 * Returns the (possibly re-anchored) base — the caller owns both refs.
 */
export function reanchorCompensationBase(
  base: CompensationBase,
  lastObserved: CompensationBase | null,
  layer: { bounding: { w: number; h: number }; cx: number; cy: number },
): CompensationBase {
  if (lastObserved) {
    const externallyMoved =
      layer.cx !== lastObserved.cx ||
      layer.cy !== lastObserved.cy ||
      layer.bounding.w !== lastObserved.w ||
      layer.bounding.h !== lastObserved.h;
    if (externallyMoved) {
      base.cx = layer.cx;
      base.cy = layer.cy;
      base.w = layer.bounding.w;
      base.h = layer.bounding.h;
    }
  }
  return base;
}
