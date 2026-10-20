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
 * TextOverlay box geometry — two cooperating halves in one module:
 *
 * 1. Sizing: the single entry point for every value that ends up in a text
 *    layer's `bounding` (or clamps the editor's on-screen box). Four write
 *    paths consume this module and nothing else may compute a box size:
 *      1. creation       (interactions.ts — point text / dragged box)
 *      2. live input     (hooks.ts handleInput → measureEditorBox)
 *      3. commit         (hooks.ts commitEditing → measureEditorBox)
 *      4. style patch    (commands.ts update_properties → measureTextBounding)
 *    Keeping the floors and formulas in one place guarantees the model
 *    bounding and the DOM presentation never disagree by construction instead
 *    of by convention.
 *
 * 2. Anchoring: align-aware centre compensation for boxes whose size changed
 *    outside a drag (typing, style patches), so the visually anchored edge
 *    stays put instead of the box growing symmetrically.
 */

import { TEXT_LAYER_PADDING } from '@opengpex/editor/core/helpers/config';

// ─── Initial creation size ─────────────────────────────────────────────────────

/**
 * Fixed initial width of a click-created (auto_width) empty text box. The box
 * is just a caret parking spot: it hugs the content from the first input on,
 * so a constant beats any font-size scaling (no per-fontSize knobs to keep in
 * sync between the model bounding and the DOM minWidth).
 */
export const INITIAL_TEXT_BOX_W_PX = 32;

/** Minimum box width for a click-created point text (just enough for the caret). */
export const POINT_TEXT_MIN_W_PX = 10;

/**
 * Height of a freshly created single-line text box: one CSS line box
 * (fontSize × lineHeight) plus vertical padding on both sides. Shared by the
 * click (point text) and drag (paragraph box) creation paths so both start
 * from the same first-line height.
 */
export function getInitialLineBoxHeight(fontSize: number, lineHeight: number): number {
  return Math.ceil(fontSize * lineHeight) + TEXT_LAYER_PADDING.y * 2;
}

/**
 * Width of a click-created point text box: the fixed caret-parking width,
 * clamped to the space between the click point and the canvas right edge
 * (`availW`), never below the caret floor.
 */
export function getInitialPointTextBoxWidth(availW: number): number {
  return Math.max(POINT_TEXT_MIN_W_PX, Math.min(INITIAL_TEXT_BOX_W_PX, availW));
}

// ─── Editor DOM constraint ─────────────────────────────────────────────────────

/**
 * CSS minWidth for the auto-width contenteditable: the same fixed
 * caret-parking width as the initial bounding, so the model and the DOM agree
 * on the very first frame for every font size. Applied directly on the
 * contenteditable element — the same element measureEditorBox reads — so the
 * constraint and the measurement can never drift apart.
 */
export function getEditorMinWidth(): string {
  return `${INITIAL_TEXT_BOX_W_PX}px`;
}

// ─── Live DOM measurement ──────────────────────────────────────────────────────

/** Width floor of a DOM-measured auto box (mirrors measureTextBounding's floor). */
export const EDITOR_MEASURE_MIN_W = 4;

/** Height floor of a DOM-measured box: always at least one full line box. */
export const EDITOR_MEASURE_MIN_H = 20;

/**
 * Measures the contenteditable's on-screen rect and converts it to canvas
 * space by dividing out the camera scale. Every live bounding measurement
 * (session mount, per-input, commit) goes through here so the floor policy —
 * width ≥ 4, height ≥ 20 — is defined exactly once.
 */
export function measureEditorBox(
  el: HTMLElement,
  cameraScale: number,
): { w: number; h: number } {
  const rect = el.getBoundingClientRect();
  const k = cameraScale || 1;
  return {
    w: Math.max(Math.ceil(rect.width / k), EDITOR_MEASURE_MIN_W),
    h: Math.max(Math.ceil(rect.height / k), EDITOR_MEASURE_MIN_H),
  };
}

// ─── Corner arm sizing ─────────────────────────────────────────────────────────

/**
 * Corner arms are a screen-constant HUD element: they NEVER scale with the
 * box. Shrinking them on small boxes (the previous overlap-avoidance attempt)
 * made the arms visibly track content width while typing — crop-mark brackets
 * are expected to stay put and may overhang a box smaller than themselves
 * (Figma's selection handles behave the same way on tiny layers). The ratio
 * plumbing (the --box-corner-arm-ratio CSS var) is kept at the neutral value
 * 1 so BoxCorners needs no knowledge of this decision.
 */
export const CORNER_ARM_NOMINAL_PX = 10;

export function safeCornerArmRatio(): number {
  return 1;
}

// ─── Align-aware anchor compensation ───────────────────────────────────────────

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
