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
 * Text box measurement — the single owner of "how big is this text" and the
 * floor policy applied to every answer. Two engines, one per lifecycle state:
 *
 * - DOM engine (`measureEditorBox`): measures the live contenteditable, the
 *   layout truth while an editing session exists. Every live bounding
 *   measurement (session mount, per-input, commit) goes through it.
 * - Canvas engine (`measureTextBounding`): re-measures from `textData` via
 *   the shared text layout with no DOM present — the style-patch path
 *   (cmd.update_properties) re-measuring auto boxes after a non-editing
 *   change. Delegates wrapping and glyph metrics to computeTextLayout so it
 *   can never drift from the layout the GPU renderer consumes.
 *
 * The two engines agree on their floor policy (width ≥ 4, height ≥ 20) and
 * on the line-box model; where their subtleties differ (fontBoundingBox
 * metrics vs CSS line boxes) the DOM engine wins whenever a contenteditable
 * exists — canvas is only the offline fallback.
 */

import type { TextLayerData } from '@opengpex/editor/core/types/models';
import { computeTextLayout, type TextMeasureContext } from '@opengpex/editor/core/engine/text/textLayout';

// ─── Measurement discipline (both engines pass through this) ──────────────────

/**
 * One-pixel equality tolerance for text box sizes. The two engines measure the
 * same text through different models (DOM line boxes vs canvas glyph metrics);
 * their answers routinely differ by exactly one pixel on a rounded edge. That
 * difference carries no layout information — treating it as a change makes the
 * style-patch path "correct" the DOM engine's value, then the next editing
 * commit "corrects" it back, and each correction lands in history as a
 * phantom no-op undo step.
 */
export const MEASURE_EQUALITY_TOLERANCE_PX = 1;

/**
 * Normalizes a raw measured size into the canonical quantized form every
 * comparison and layout decision consumes: FLOOR each axis, then add one
 * pixel. The +1 slack mirrors the DOM editor's tolerance for sub-pixel line
 * boxes and guarantees the value never clips glyphs after rounding down —
 * slightly generous is safe, one pixel short is a re-wrap trigger. Both
 * engines funnel their raw answers through this single function so a wrap
 * decision or an "is it different" check can never see engine-specific
 * rounding (the DOM engine used to ceil, the canvas engine ceil — but on
 * different bases, which is exactly where the one-pixel fights came from).
 */
export function normalizeMeasuredBox(size: { w: number; h: number }): { w: number; h: number } {
  return {
    w: Math.max(Math.floor(size.w) + 1, EDITOR_MEASURE_MIN_W),
    h: Math.max(Math.floor(size.h) + 1, EDITOR_MEASURE_MIN_H),
  };
}

/**
 * Whether two measured box sizes differ by MORE than the one-pixel tolerance —
 * the single "is this a real layout change" predicate. Differences inside the
 * tolerance are engine noise: callers must treat the two sizes as equal and
 * keep the value they already hold (never write the other engine's answer
 * back), which is what kills the ±1px bounding ping-pong between the editing
 * commit and the style-patch re-measure.
 */
export function measuredBoxesDiffer(
  a: { w: number; h: number },
  b: { w: number; h: number },
): boolean {
  return (
    Math.abs(a.w - b.w) > MEASURE_EQUALITY_TOLERANCE_PX ||
    Math.abs(a.h - b.h) > MEASURE_EQUALITY_TOLERANCE_PX
  );
}

// ─── Shared offscreen editor measure context ───────────────────────────────────

/**
 * Shared offscreen measuring surface for the editor's layout calls (same
 * structurally-satisfied Canvas2D context the vector-source mapper uses).
 * Exported so the inline caret solver (TextCaretKit caretLayout) measures
 * with the identical context — caret geometry and GPU geometry must agree.
 */
let editorMeasureContext: TextMeasureContext | null = null;
export function getEditorMeasureContext(): TextMeasureContext | null {
  if (editorMeasureContext) return editorMeasureContext;
  if (typeof document === 'undefined') return null;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  editorMeasureContext = ctx as unknown as TextMeasureContext;
  return editorMeasureContext;
}

// ─── DOM engine (live editing sessions) ────────────────────────────────────────

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
  return normalizeMeasuredBox({
    w: rect.width / k,
    h: rect.height / k,
  });
}

// ─── Canvas engine (offline re-measurement) ────────────────────────────────────

let measureCtx: CanvasRenderingContext2D | null = null;
function getMeasureCtx(): CanvasRenderingContext2D {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d')!;
  }
  return measureCtx;
}

/**
 * Measure the content bounding of a text layer for the style-patch path
 * (cmd.update_properties), delegating wrapping and glyph measurement to the
 * shared `computeTextLayout` so this path can never drift from the layout the
 * GPU renderer and the DOM editor both consume. The height uses the same
 * line-box model as the DOM editor: one `fontSize × lineHeight` box per
 * content line. With `wrapWidth` (auto_height
 * mode) lines wrap at the locked width first. Slightly generous is fine — it
 * only has to never clip the glyphs.
 */
export function measureTextBounding(td: TextLayerData, wrapWidth?: number): { w: number; h: number } {
  const ctx = getMeasureCtx();
  const layout = computeTextLayout(
    ctx,
    { ...td, boxMode: wrapWidth !== undefined ? 'auto_height' : 'auto_width' },
    wrapWidth ?? 0,
    0,
  );
  let maxLineW = 0;
  for (const line of layout.lines) maxLineW = Math.max(maxLineW, line.width);
  // auto_height: the width is locked (boxWidth is the owner of that axis), so
  // it is echoed back verbatim — only the measured height passes through the
  // normalization rule.
  if (wrapWidth !== undefined) {
    const h = normalizeMeasuredBox({ w: wrapWidth, h: layout.lines.length * layout.lineHeight }).h;
    return { w: wrapWidth, h: h };
  }
  return normalizeMeasuredBox({
    w: maxLineW,
    h: layout.lines.length * layout.lineHeight,
  });
}
