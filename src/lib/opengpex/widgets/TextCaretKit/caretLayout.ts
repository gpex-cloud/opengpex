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
 * TextCaretKit caretLayout: read-only scalarization of the contenteditable DOM
 * plus a pure-mathematical caret solver backed by the shared text layout.
 *
 * The DOM is asked exactly one scalar question — "which code point of the
 * content string is the collapsed selection on?" — and every geometric answer
 * (line, column, x, y) is derived from `computeTextLayout`, the same layout
 * the GPU renderer paints with. No client rects are read on this path, so the
 * whole class of "collapsed Range returned no/ambiguous rects" bugs (line
 * starts after <br>, empty lines, textAlign-ignored line starts) disappears
 * structurally rather than being patched case by case.
 *
 * Strictly read-only: nothing here mutates the DOM or the selection, so
 * calling it can never feed back into the selectionchange events it serves.
 *
 * @module widgets/TextCaretKit/caretLayout
 */

import { TEXT_LAYER_PADDING } from '@opengpex/editor/core/helpers/config';
import { normalizeBoxMode } from '@opengpex/editor/core/types/models';
import {
  computeTextLayout,
  wrapText,
  type TextLayout,
  type TextLayoutInput,
  type TextMeasureContext,
  type WrappedTextLine,
} from '@opengpex/editor/core/engine/text/textLayout';

/** Numeric node-type constants — kept local so the module stays testable in a
 * bare Node environment where the DOM `Node` global does not exist. */
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** Block-level elements whose boundaries contribute a '\n' (innerText rules). */
const BLOCK_TAGS = new Set(['DIV', 'P']);

function isElement(node: { nodeType: number }): boolean {
  return node.nodeType === ELEMENT_NODE;
}

function tagName(node: unknown): string {
  const el = node as { tagName?: string };
  return typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
}

function isBlockElement(node: unknown): boolean {
  return isElement(node as { nodeType: number }) && BLOCK_TAGS.has(tagName(node));
}

function isBreakElement(node: unknown): boolean {
  return isElement(node as { nodeType: number }) && tagName(node) === 'BR';
}

function codePointCount(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/**
 * Read-only linearization of the contenteditable content.
 * `text` reproduces `el.innerText` semantics for the structures the editor
 * produces (text nodes, <br>, block <div>/<p>, inline wrappers): every <br>
 * contributes exactly one '\n' (including a trailing one — it holds the
 * visible empty last line), and every block element contributes one '\n'
 * after its content unless it is the last node of its container.
 */
export interface ContentLinearization {
  text: string;
  /**
   * Code point index of the caret position identified by a collapsed-range
   * (node, offset) pair. Null when the node is outside the linearized tree or
   * carries an out-of-range offset — the caller falls back to rect inference.
   */
  indexOf(node: unknown, offset: number): number | null;
}

/**
 * Linearize the editor content without mutating anything. Returns the
 * innerText-equivalent string plus a mapper from DOM caret positions to code
 * point indices. Never returns null: an empty editor linearizes to ''.
 */
export function linearizeContent(root: unknown): ContentLinearization {
  const pieces: string[] = [];
  let cp = 0;
  // Per text node: code point index of its first character and its full text.
  const textStarts = new Map<unknown, { start: number; text: string }>();
  // Per node: code point index just AFTER the node's content — for block
  // children this includes the appended boundary '\n', so a caret placed
  // between two blocks resolves to the START of the following line (matching
  // where the browser renders it).
  const endAfter = new Map<unknown, number>();
  // Per element: code point index just BEFORE its content (offset-0 carets).
  const startBefore = new Map<unknown, number>();

  const append = (text: string): void => {
    if (!text) return;
    pieces.push(text);
    cp += codePointCount(text);
  };

  const visit = (node: unknown): void => {
    const n = node as { nodeType: number; textContent?: string; childNodes?: ArrayLike<unknown> };
    if (n.nodeType === TEXT_NODE) {
      const text = n.textContent ?? '';
      textStarts.set(node, { start: cp, text });
      append(text);
      return;
    }
    if (n.nodeType === ELEMENT_NODE) {
      startBefore.set(node, cp);
      if (isBreakElement(node)) {
        append('\n');
        return;
      }
      const children = n.childNodes;
      if (!children) return;
      const count = children.length;
      for (let i = 0; i < count; i++) {
        const child = children[i];
        visit(child);
        endAfter.set(child, cp);
        if (isBlockElement(child) && i < count - 1) append('\n');
      }
    }
  };

  visit(root);

  return {
    text: pieces.join(''),
    indexOf(node: unknown, offset: number): number | null {
      const anchor = textStarts.get(node);
      if (anchor) {
        if (offset < 0 || offset > anchor.text.length) return null;
        return anchor.start + codePointCount(anchor.text.slice(0, offset));
      }
      if (!isElement(node as { nodeType: number })) return null;
      if (offset === 0) {
        const start = startBefore.get(node);
        return start !== undefined ? start : null;
      }
      const children = (node as { childNodes?: ArrayLike<unknown> }).childNodes;
      if (!children || offset > children.length) return null;
      const end = endAfter.get(children[offset - 1]);
      return end !== undefined ? end : null;
    },
  };
}

/** Layout-backed fast path descriptor handed in by the host. */
export interface CaretLayoutSource {
  /**
   * Style + box descriptor (`TextLayerData` satisfies it structurally).
   * `verticalAlign` is forced to 'top' internally — the host applies its own
   * fixed-mode paddingTop, which the solver adds back explicitly, so the
   * layout must not bake the offset in a second time.
   */
  input: TextLayoutInput;
  boxWidth: number;
  boxHeight: number;
  /**
   * Offscreen Canvas2D measure surface — the SAME context the host's layout
   * calls use, so caret geometry and GPU geometry measure identically.
   */
  measure: () => TextMeasureContext | null;
}

interface LayoutCacheEntry {
  key: string;
  text: string;
  layout: TextLayout;
  /** Wrapped lines per paragraph (no-wrap modes: exactly one line each). */
  wrapped: WrappedTextLine[][];
}

/** Per-editor cache: recomputed only when the content string or a style field
 * changes; pure caret movement (selectionchange without input) is a lookup. */
const layoutCache = new WeakMap<object, LayoutCacheEntry>();

function styleKeyOf(source: CaretLayoutSource): string {
  const i = source.input;
  return JSON.stringify([
    i.fontFamily,
    i.fontSize,
    i.fontWeight,
    i.italic,
    i.lineHeight,
    i.letterSpacing,
    i.align,
    i.boxMode,
    i.boxWidth,
    i.boxHeight,
    source.boxWidth,
    source.boxHeight,
  ]);
}

/**
 * Solve the caret's container-local position from the linearized content and
 * the shared text layout. Returns null when the math path cannot answer
 * (no measure surface, layout/wrap divergence, unmappable index) — the caller
 * falls back to rect inference.
 */
export function solveCaretFromLayout(
  content: ContentLinearization,
  caretIndex: number,
  cacheKey: object,
  source: CaretLayoutSource,
  verticalAlignOffset: number,
  caretHeight: number,
): { localX: number; localY: number } | null {
  const measure = source.measure();
  if (!measure || caretIndex < 0) return null;

  const text = content.text;
  const key = `${text}\u0000${styleKeyOf(source)}`;
  let entry = layoutCache.get(cacheKey);
  if (!entry || entry.key !== key) {
    const layout = computeTextLayout(
      measure,
      { ...source.input, content: text, verticalAlign: 'top' },
      source.boxWidth,
      source.boxHeight,
    );
    const boxMode = normalizeBoxMode(source.input.boxMode);
    const wrapMode = boxMode === 'fixed' || boxMode === 'auto_height';
    const maxWidth = wrapMode
      ? (source.input.boxWidth || source.boxWidth) - TEXT_LAYER_PADDING.x * 2
      : 0;
    const paragraphs = text.split('\n');
    const wrapped: WrappedTextLine[][] = paragraphs.map((p) =>
      wrapMode ? wrapText(measure, p, maxWidth) : [{ text: p, start: 0 }],
    );
    const totalLines = wrapped.reduce((sum, ls) => sum + ls.length, 0);
    // The wrap pass must agree with the layout's line count; a mismatch means
    // measurement divergence — refuse the math path rather than misplace the
    // caret (only fixed-mode clipping legitimately shortens layout.lines).
    if (!layout.clipped && totalLines !== layout.lines.length) return null;
    entry = { key, text, layout, wrapped };
    layoutCache.set(cacheKey, entry);
  }

  // Locate the paragraph containing the caret. A caret sitting exactly on a
  // paragraph's terminating '\n' belongs to that paragraph's last line end.
  const paragraphs = entry.text.split('\n');
  let base = 0;
  let paraIdx = paragraphs.length - 1;
  let off = codePointCount(paragraphs[paraIdx]);
  const totalCps = codePointCount(entry.text);
  if (caretIndex < totalCps) {
    base = 0;
    paraIdx = -1;
    off = 0;
    for (let i = 0; i < paragraphs.length; i++) {
      const plen = codePointCount(paragraphs[i]);
      if (caretIndex <= base + plen) {
        paraIdx = i;
        off = caretIndex - base;
        break;
      }
      base += plen + 1;
    }
    if (paraIdx < 0) return null;
  }

  // Locate the visual line within the paragraph straight from the wrap's
  // source offsets: line i owns the half-open range [start_i, start_{i+1}] —
  // a caret exactly ON a soft-wrap boundary renders at the PREVIOUS line's
  // trailing edge, mirroring Chrome (the collapsed selection there reports
  // rects[0] on the previous line regardless of typing or click affinity,
  // and inserted text lands there too). Whitespace the wrap stripped at the
  // break point falls inside the preceding line's range, so a caret sitting
  // in it (a space typed at the line edge) resolves the same way; its
  // advance width is measured from the source below — no string matching.
  const lines = entry.wrapped[paraIdx];
  if (!lines || lines.length === 0) return null;
  const paraChars = Array.from(paragraphs[paraIdx]);
  const paraCps = paraChars.length;
  let localLine = lines.length - 1;
  let lineStart = lines[localLine].start;
  for (let i = 0; i < lines.length; i++) {
    const rangeEnd = i + 1 < lines.length ? lines[i + 1].start : paraCps;
    if (off <= rangeEnd) {
      localLine = i;
      lineStart = lines[i].start;
      break;
    }
  }
  const col = Math.max(0, Math.min(off - lineStart, paraCps - lineStart));

  let globalLine = 0;
  for (let i = 0; i < paraIdx; i++) globalLine += entry.wrapped[i].length;
  globalLine += localLine;
  const allLines = entry.layout.lines;
  let line: (typeof allLines)[number] | undefined;
  // Number of line-height steps the caret sits past the last visible line.
  let overflowSteps = 0;
  if (globalLine < allLines.length) {
    line = allLines[globalLine];
  } else {
    // Fixed-mode clipping drops every line past the box height, but the DOM
    // keeps rendering them (edit state uses overflow: visible), so the caret
    // must track its true off-box position instead of snapping back to the
    // last visible line. Clipped lines have deterministic geometry: the
    // layout walks one line height per wrapped line, so extrapolating from
    // the last visible line reproduces the exact baseline the layout would
    // have produced (overflow also forces vAlignOffset to 0, content taller
    // than the box is always top-anchored).
    if (!entry.layout.clipped || allLines.length === 0) return null;
    overflowSteps = globalLine - (allLines.length - 1);
    line = allLines[allLines.length - 1];
  }
  if (!line) return null;

  // Column x. `col` is measured from the line's source start, so it may sit
  // past the wrapped line's visible text (whitespace the wrap stripped at the
  // break point — a space typed at the line edge hangs there). Measure the
  // column prefix straight from the paragraph source in that case; for a
  // column inside the visible text, the layout's charX is the exact fast
  // path. For a clipped line (extrapolated off-box) there is no layout entry
  // to read, so mirror the layout's own line assembly: identical font state,
  // identical alignment formula for the left edge.
  const caretLineText = lines[localLine].text;
  const caretLineCps = codePointCount(caretLineText);
  const charXUsable = !overflowSteps && col <= caretLineCps && !!line.charX && line.charX.length > 0;

  let localX: number;
  if (charXUsable) {
    localX =
      col < line.charX!.length ? line.charX![col] : line.x + line.width;
  } else {
    measure.font = `${source.input.italic ? 'italic' : 'normal'} ${source.input.fontWeight || 400} ${source.input.fontSize || 24}px ${source.input.fontFamily || 'sans-serif'}`;
    if ('letterSpacing' in measure) measure.letterSpacing = `${source.input.letterSpacing || 0}px`;
    measure.textAlign = 'left';
    const width = measure.measureText(caretLineText).width;
    const padX = TEXT_LAYER_PADDING.x;
    const x =
      source.input.align === 'center'
        ? source.boxWidth / 2 - width / 2
        : source.input.align === 'right'
          ? source.boxWidth - padX - width
          : padX;
    const prefix = paraChars.slice(lineStart, lineStart + col).join('');
    localX = x + measure.measureText(prefix).width;
  }
  const lineTop = line.baselineY - entry.layout.fontAscent + overflowSteps * entry.layout.lineHeight;
  const localY =
    lineTop + verticalAlignOffset + Math.max(0, (entry.layout.lineHeight - caretHeight) / 2);
  return { localX, localY };
}
