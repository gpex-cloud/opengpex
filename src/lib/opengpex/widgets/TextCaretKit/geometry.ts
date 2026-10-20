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
 * TextCaretKit geometry: pure DOM/measurement helpers for the custom caret.
 *
 * No React, no editor state — every function takes what it needs as arguments
 * so it can be unit-tested against a bare DOM (or jsdom stubs) in isolation.
 *
 * Caret position resolution is layered:
 * 1. Math path (caretLayout.ts): the DOM selection is scalarized to a code
 *    point index and the position is solved from the shared text layout —
 *    no client rects, no per-shape special cases.
 * 2. Rect fallback: when the math path cannot answer, the collapsed range's
 *    own client rects (or, at a text node's trailing edge, the previous
 *    character's right edge) are projected through the live container matrix.
 * 3. Degenerate endings: genuinely empty content snaps to the start padding;
 *    any other unmeasurable state keeps the previously rendered caret —
 *    never a hijack to the first line.
 *
 * Every path is strictly read-only: nothing here ever mutates the DOM or the
 * selection, so resolution can never feed back into the selectionchange
 * events it serves.
 */

import {
  linearizeContent,
  solveCaretFromLayout,
  type CaretLayoutSource,
} from './caretLayout';

/** Numeric node-type constant — the DOM `Node` global is unavailable in the
 * bare Node test environment, and only text nodes are probed here. */
const NODE_TEXT = 3;

/** Viewport-space caret rectangle as reported by DOM selection APIs. */
export interface CaretScreenRect {
  left: number;
  top: number;
  height: number;
}

/** Container-local caret anchor (what the rendered caret bar positions at). */
export interface CaretAnchor {
  localX: number;
  localY: number;
  height: number;
}

/**
 * Resolution outcome for one caret update:
 * - hidden: no caret should be rendered (no focus / no collapsed selection).
 * - keepPrevious: measurement failed transiently (degenerate matrix) — leave
 *   the currently rendered caret where it is.
 * - visible: render at the given container-local anchor.
 */
export type CaretResolution =
  | { kind: 'hidden' }
  | { kind: 'keepPrevious' }
  | { kind: 'visible'; anchor: CaretAnchor };

/** Default options shared by the resolution entry point. */
export interface CaretResolveOptions {
  fontSize: number;
  lineHeight: number;
  /** Vertical offset of the content block (fixed-mode top alignment). */
  verticalAlignOffset: number;
  /** Content padding used when snapping to the start (empty content). */
  startPadding: { x: number; y: number };
  /** Live container-local→viewport matrix provider (see getLiveMatrixFromOffsetParent). */
  getLiveMatrix: () => DOMMatrixReadOnly | null;
  /**
   * Layout-backed math fast path (see caretLayout.ts). When provided and an
   * IME composition is NOT active, the caret position is solved purely from
   * the live DOM content string against the shared text layout; rect
   * inference remains as the fallback for unlinearizable/unsolvable states.
   */
  caretLayout?: CaretLayoutSource;
  /** True while an IME composition is active — forces the rect fallback,
   * because the composition string is browser-managed transient DOM. */
  isComposing?: boolean;
}

/**
 * Screen-constant caret bar height: glyph cap-height-ish clamp so the caret
 * never spans the full fontSize × lineHeight box.
 */
export function getCaretHeight(fontSize: number): number {
  return Math.max(10, fontSize * 0.86);
}

/**
 * Step (in UTF-16 code units) from a caret offset to the start of the previous
 * full code point, so surrogate pairs are stepped over as one glyph.
 */
function previousCodePointStep(text: string | null | undefined, offset: number): number {
  if (!text || offset < 1) return 1;
  const unit = text.charCodeAt(offset - 1);
  if (unit >= 0xdc00 && unit <= 0xdfff && offset >= 2) {
    const high = text.charCodeAt(offset - 2);
    if (high >= 0xd800 && high <= 0xdbff) return 2;
  }
  return 1;
}

/**
 * Resolve the caret's viewport-space rectangle for a collapsed selection.
 * RECT FALLBACK only — the primary path is the layout-backed math solver in
 * caretLayout.ts; this function serves states the math path cannot answer.
 *
 * Strictly read-only — this function NEVER mutates the DOM or the selection:
 * - Direct position: the collapsed range's own client rects (glyph lines).
 * - Trailing edge (caret after the last character of a text node): the
 *   previous character's rect; its right edge already includes any
 *   letter-spacing, so the value is the browser's own layout truth (kept
 *   unrounded — subpixel is exact, rounding would introduce error).
 * There is deliberately NO per-shape special casing beyond these two: line
 * starts, empty lines and alignment are solved by the math path; when rects
 * are unavailable here the caller keeps the previous caret instead of
 * guessing (guessing is what produced the line-start hijack bugs).
 * Returns null when nothing measurable surrounds the caret.
 */
export function resolveCaretScreenRect(
  editor: HTMLElement,
  sel: Selection,
): CaretScreenRect | null {
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return null;

  const rects = range.getClientRects();
  if (rects.length > 0 && rects[0].height > 0) {
    return { left: rects[0].left, top: rects[0].top, height: rects[0].height };
  }

  const node = range.startContainer as { nodeType: number; textContent?: string } | null;
  const offset = range.startOffset;

  // Trailing edge: caret at the end of a text node → previous character.
  if (node && node.nodeType === NODE_TEXT && offset > 0) {
    const step = previousCodePointStep(node.textContent, offset);
    const r = document.createRange();
    r.setStart(range.startContainer, offset - step);
    r.setEnd(range.startContainer, offset);
    const charRects = r.getClientRects();
    const last = charRects[charRects.length - 1];
    if (last && last.height > 0) {
      return { left: last.right, top: last.top, height: last.height };
    }
  }

  return null;
}

/**
 * Read the LIVE container-local→viewport matrix of the element that hosts the
 * editor: its nearest positioned ancestor's computed transform. This pairs
 * with hosts that reposition the container by writing the DOM transform
 * directly on every animation tick (bypassing React) — a matrix captured at
 * render time would go stale after the first pan/zoom.
 */
export function getLiveMatrixFromOffsetParent(editor: HTMLElement): DOMMatrixReadOnly | null {
  const container = editor.offsetParent as HTMLElement | null;
  if (!container) return null;
  const transform = getComputedStyle(container).transform;
  if (!transform || transform === 'none') return null;
  try {
    return new DOMMatrixReadOnly(transform);
  } catch {
    return null;
  }
}

/**
 * Project a viewport-space rect into container-local coordinates via the given
 * matrix. Returns null for degenerate (singular) matrices — the caller should
 * keep the previously rendered caret rather than snapping somewhere wrong.
 */
export function projectScreenRectToLocal(
  rect: CaretScreenRect,
  matrix: DOMMatrixReadOnly,
): { localX: number; localY: number } | null {
  const a = matrix.a;
  const b = matrix.b;
  const c = matrix.c;
  const d = matrix.d;
  const tx = matrix.m41;
  const ty = matrix.m42;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-6) return null;

  const dx = rect.left - tx;
  const dy = rect.top - ty;
  const localX = (d * dx - c * dy) / det;
  const localY = (-b * dx + a * dy) / det;
  return { localX, localY };
}

/**
 * Full caret resolution for one update pass. Pure with respect to its inputs;
 * the only DOM access is through `editor`, `window.getSelection()` and the
 * injected providers.
 *
 * This is the kit's public caretPos entry point: given the editor element and
 * the live selection it answers "where is the caret, container-locally" with
 * ZERO DOM or selection mutation (see resolveCaretScreenRect and
 * caretLayout.ts), so calling it can never feed back into the selectionchange
 * events it listens to.
 *
 * Order: math path (layout-backed, primary) → rect fallback → degenerate
 * endings (empty content snaps to start padding; anything else unmeasurable
 * keeps the previously rendered caret).
 */
export function resolveCaretAnchor(
  editor: HTMLElement | null,
  options: CaretResolveOptions,
): CaretResolution {
  if (!editor) return { kind: 'hidden' };

  // Only display caret if editor or document activeElement has focus
  const isFocused =
    document.activeElement === editor || editor.contains(document.activeElement);
  if (!isFocused) return { kind: 'hidden' };

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return { kind: 'hidden' };

  const caretH = getCaretHeight(options.fontSize);

  // Math path: scalarize the collapsed selection to a code point index of the
  // live content string, then solve (line, column) against the shared layout.
  const linearization = linearizeContent(editor);
  if (linearization && options.caretLayout && !options.isComposing) {
    const range = sel.getRangeAt(0);
    if (editor.contains(range.startContainer)) {
      const caretIndex = linearization.indexOf(range.startContainer, range.startOffset);
      const solved =
        caretIndex !== null
          ? solveCaretFromLayout(
              linearization,
              caretIndex,
              editor,
              options.caretLayout,
              options.verticalAlignOffset,
              caretH,
            )
          : null;
      if (solved) {
        return { kind: 'visible', anchor: { localX: solved.localX, localY: solved.localY, height: caretH } };
      }
    }
  }

  // Rect fallback: browser-reported rects projected through the live matrix.
  const screenRect = resolveCaretScreenRect(editor, sel);
  if (screenRect) {
    const matrix = options.getLiveMatrix();
    if (matrix) {
      const local = projectScreenRectToLocal(screenRect, matrix);
      if (local) {
        const currentScale = Math.hypot(matrix.a, matrix.b) || 1;
        const rowH =
          screenRect.height > 0
            ? screenRect.height / currentScale
            : options.fontSize * options.lineHeight;
        const offsetY = Math.max(0, (rowH - caretH) / 2);
        return {
          kind: 'visible',
          anchor: { localX: local.localX, localY: local.localY + offsetY, height: caretH },
        };
      }
    } else {
      return { kind: 'keepPrevious' };
    }
  }

  // Nothing measurable: only genuinely empty content snaps to the start
  // padding anchor; any other failure keeps the previous caret rather than
  // hijacking it to the first line (the historical line-start bug).
  if (!linearization || linearization.text === '') {
    const lineH = options.fontSize * options.lineHeight;
    const offsetY = Math.max(0, (lineH - caretH) / 2);
    return {
      kind: 'visible',
      anchor: {
        localX: options.startPadding.x,
        localY: options.startPadding.y + options.verticalAlignOffset + offsetY,
        height: caretH,
      },
    };
  }
  return { kind: 'keepPrevious' };
}

/**
 * Place the collapsed caret at a viewport-space point inside the editor
 * (browser hit-testing against the laid-out DOM). Normalizes the
 * caretRangeFromPoint (Chromium/Safari) and caretPositionFromPoint (Firefox)
 * APIs into a Range and applies it. Returns false when the point cannot be
 * resolved inside the editor — the caller should fall back (e.g. end of text).
 */
export function placeCaretAtPoint(
  editor: HTMLElement,
  clientX: number,
  clientY: number,
): boolean {
  try {
    let range: Range | null = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(clientX, clientY);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(clientX, clientY);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }
    if (!range || !editor.contains(range.startContainer)) return false;

    const sel = window.getSelection();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  } catch {
    return false;
  }
}

/**
 * caretPos — the kit's measurement facade (alias of resolveCaretAnchor):
 * "given the text box and the selection, where is the caret?" Everything the
 * answer needs (live container matrix, glyph-line rects, degenerate-position
 * inference) is resolved inside the kit; hosts never measure themselves.
 */
export const caretPos = resolveCaretAnchor;

/** Container-local selection rectangle for custom text highlight. */
export interface TextSelectionRect {
  localX: number;
  localY: number;
  width: number;
  height: number;
}

export interface SelectionResolveOptions {
  fontSize: number;
  lineHeight?: number;
  getLiveMatrix: () => DOMMatrixReadOnly | null;
}

/**
 * Resolve container-local selection rectangles for a non-collapsed text selection.
 * Clamps each row's highlight height to glyph bounds (1.06 × fontSize)
 * and centers vertically within the line, preventing oversized / overlapping
 * selection boxes across adjacent lines (especially for CJK / large fonts).
 */
export function resolveSelectionRects(
  editor: HTMLElement | null,
  options: SelectionResolveOptions,
): TextSelectionRect[] {
  if (!editor) return [];

  const isFocused =
    document.activeElement === editor || editor.contains(document.activeElement);
  if (!isFocused) return [];

  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return [];

  const range = sel.getRangeAt(0);
  if (
    !editor.contains(range.commonAncestorContainer) &&
    !editor.contains(range.startContainer) &&
    !editor.contains(range.endContainer)
  ) {
    return [];
  }

  const rawRects = Array.from(range.getClientRects()).filter(
    (r) => r.width > 0 && r.height > 0,
  );
  if (rawRects.length === 0) return [];

  const matrix = options.getLiveMatrix();
  if (!matrix) return [];

  const currentScale = Math.hypot(matrix.a, matrix.b) || 1;
  // Maximum line highlight height is strictly bounded by the line pitch (fontSize × lineHeight).
  // When lineHeight is 1.0, height is exactly 1.0 × fontSize, so adjacent lines meet flush with 0 overlap.
  const linePitch = options.fontSize * (options.lineHeight ?? 1.4);
  const targetH = Math.max(8, linePitch);

  // Group / merge horizontally adjacent rects on the same line
  const mergedRects: Array<{ left: number; top: number; right: number; bottom: number }> = [];
  const sorted = [...rawRects].sort((a, b) => a.top - b.top || a.left - b.left);

  for (const r of sorted) {
    const rLeft = r.left;
    const rTop = r.top;
    const rRight = r.right !== undefined ? r.right : r.left + r.width;
    const rBottom = r.bottom !== undefined ? r.bottom : r.top + r.height;

    const prev = mergedRects[mergedRects.length - 1];
    if (
      prev &&
      Math.abs(prev.top - rTop) < 4 &&
      rLeft <= prev.right + 2
    ) {
      prev.right = Math.max(prev.right, rRight);
      prev.bottom = Math.max(prev.bottom, rBottom);
      prev.top = Math.min(prev.top, rTop);
    } else {
      mergedRects.push({ left: rLeft, top: rTop, right: rRight, bottom: rBottom });
    }
  }

  const results: TextSelectionRect[] = [];
  for (const m of mergedRects) {
    const screenW = m.right - m.left;
    const screenH = m.bottom - m.top;
    if (screenW <= 0 || screenH <= 0) continue;

    const localTopLeft = projectScreenRectToLocal(
      { left: m.left, top: m.top, height: screenH },
      matrix,
    );
    if (!localTopLeft) continue;

    const rowH = screenH / currentScale;
    const clampedH = Math.min(rowH, targetH);
    const offsetY = Math.max(0, (rowH - clampedH) / 2);

    results.push({
      localX: localTopLeft.localX,
      localY: localTopLeft.localY + offsetY,
      width: screenW / currentScale,
      height: clampedH,
    });
  }

  // Sort rows top-to-bottom, left-to-right
  results.sort((a, b) => a.localY - b.localY || a.localX - b.localX);

  // Guarantee ZERO overlap across vertically adjacent lines:
  // If subpixel rounding or font ascender metrics cause line i to extend past line i+1's top,
  // clamp line i's height so they meet exactly flush without double-blending banding.
  for (let i = 0; i < results.length - 1; i++) {
    const cur = results[i];
    const nxt = results[i + 1];
    if (nxt.localY > cur.localY && cur.localY + cur.height > nxt.localY) {
      cur.height = Math.max(1, nxt.localY - cur.localY);
    }
  }

  return results;
}
