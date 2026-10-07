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
 * textLayout.ts — resolution-independent text layout as pure data.
 *
 * Single source of truth for text geometry shared by the GPU TextRenderer
 * and the DOM contenteditable. Input is `TextLayerData` (three-state `boxMode`,
 * `TEXT_LAYER_PADDING`, `letterSpacing`, `verticalAlign`); output is a pure
 * `TextLayout` in logical (density-independent) pixels — GPU consumers scale
 * by target density themselves.
 *
 * The baseline model replicates the CSS line box: half-leading is computed
 * against the font's content area (fontBoundingBox ascent + descent), lines
 * are positioned via the alphabetic baseline, and metrics are probed with the
 * first real content line so CJK/fallback glyph metrics are reflected.
 *
 * @module core/engine/text/textLayout
 */

import { TEXT_LAYER_PADDING } from '@opengpex/editor/core/helpers/config';
import type { TextLayerData } from '@opengpex/editor/core/types/models';

/**
 * Minimal measuring surface consumed by the layout functions. Both 2D
 * contexts satisfy this structurally; tests may pass a stub.
 */
export interface TextMeasureContext {
  font: string;
  textAlign: string;
  letterSpacing?: string;
  measureText(text: string): {
    width: number;
    fontBoundingBoxAscent?: number;
    fontBoundingBoxDescent?: number;
  };
}

/** One laid-out line. All coordinates are box-local logical px. */
export interface TextLineLayout {
  text: string;
  /** Left edge of the line after horizontal alignment is applied. */
  x: number;
  /** Alphabetic baseline y of the line. */
  baselineY: number;
  /** Measured advance width of `text`. */
  width: number;
  /**
   * Per-character left-edge x offsets (one entry per code point of `text`),
   * consumed by the GPU glyph renderer to place one quad per character. The
   * Canvas2D painter ignores this — it fills the whole line string. Positions
   * are measured as prefix advances (kerning + `letterSpacing` included), so
   * they reproduce exactly where the browser would ink each glyph.
   */
  charX?: number[];
}

/** Solid decoration rectangle (underline / strikethrough), box-local px. */
export interface TextDecorationRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextLayout {
  lines: TextLineLayout[];
  /** Empty unless `textData.underline`. */
  underlines: TextDecorationRect[];
  /** Empty unless `textData.strikethrough`. */
  strikethroughs: TextDecorationRect[];
  /** Line height (fontSize × lineHeight) in logical px. */
  lineHeight: number;
  /** Probe-line font bounding metrics and derived half-leading. */
  fontAscent: number;
  fontDescent: number;
  halfLeading: number;
  /** True when fixed-mode clipping dropped at least one wrapped line. */
  clipped: boolean;
  /**
   * Fixed-mode vertical alignment offset (the shift applied to every line's
   * baseline so the visible content block sits middle/bottom in the box).
   * Republished so the DOM editor can position content with the exact same
   * offset instead of re-deriving it with flex centering (whose block height
   * includes the contenteditable's invisible trailing line box — a half-line
   * visual offset the GPU layout must not replicate).
   */
  vAlignOffset: number;
}

/** Scripts where a line break is allowed between any two characters. */
const CJK_CHAR_RE =
  /[\u1100-\u11FF\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]|[\u{20000}-\u{2FA1F}]/u;

type WrapUnit = { text: string; kind: 'word' | 'char' | 'space' };

/**
 * Splits a paragraph into greedy-breaking units: unbreakable words (Latin and
 * other space-delimited scripts), individual CJK characters (break between
 * any two), and space runs. Break opportunities exist between every pair of
 * units — mirroring the CSS `normal` line-breaking model.
 */
function tokenizeForWrap(text: string): WrapUnit[] {
  const units: WrapUnit[] = [];
  let run = '';
  let runKind: WrapUnit['kind'] | null = null;

  const flush = () => {
    if (run) units.push({ text: run, kind: runKind! });
    run = '';
    runKind = null;
  };

  for (const ch of text) {
    const kind: WrapUnit['kind'] = /\s/.test(ch) ? 'space' : CJK_CHAR_RE.test(ch) ? 'char' : 'word';
    // Each CJK char is its own break unit — never merge adjacent chars.
    if (kind !== runKind || kind === 'char') {
      flush();
      runKind = kind;
    }
    run += ch;
  }
  flush();
  return units;
}

function trimTrailingSpaces(line: string): string {
  return line.replace(/\s+$/, '');
}

/**
 * Word-aware greedy line wrap aligned with DOM contenteditable behaviour:
 * Latin words never break mid-word (a word wider than the line overflows,
 * as in CSS `overflow-wrap: normal`), CJK text breaks between characters,
 * and trailing spaces collapse at a break point.
 */
export function wrapText(
  mc: TextMeasureContext,
  text: string,
  maxWidth: number,
): string[] {
  if (!text) return [''];
  const lines: string[] = [];
  let line = '';

  for (const unit of tokenizeForWrap(text)) {
    if (unit.kind === 'space') {
      // Leading spaces after a break point collapse (CSS behaviour).
      if (line) line += unit.text;
      continue;
    }
    const candidate = line + unit.text;
    if (!line || mc.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      lines.push(trimTrailingSpaces(line));
      line = unit.text;
    }
  }
  lines.push(trimTrailingSpaces(line));
  return lines;
}

/**
 * Layout input. Accepted as a partial (its `align` is loosened to
 * `string`); every field consumed below is normalized with an explicit
 * default.
 */
export type TextLayoutInput = Omit<Partial<TextLayerData>, 'align'> & { align?: string };

/**
 * Computes the full text layout for a text layer as pure data.
 * All output coordinates are box-local logical pixels; horizontal alignment
 * (`align`) and fixed-mode vertical alignment (`verticalAlign`) are resolved
 * into per-line x / baselineY, so consumers never need alignment logic.
 */
export function computeTextLayout(
  mc: TextMeasureContext,
  td: TextLayoutInput,
  boxW: number,
  boxH: number,
): TextLayout {
  const fontSize = td.fontSize || 24;
  const lineH = fontSize * (td.lineHeight || 1.4);
  const boxMode = td.boxMode || 'auto';
  // 'auto_height' and 'fixed' both wrap at the box width; only 'fixed' clips
  // the lines that overflow the box height ('auto_height' grows downward).
  const wrapMode = boxMode === 'fixed' || boxMode === 'auto_height';
  const clipToBox = boxMode === 'fixed';
  const padX = TEXT_LAYER_PADDING.x;
  const padY = TEXT_LAYER_PADDING.y;

  // Layout owns the measurement state so every consumer measures identically
  // (a shared/reused context never inherits a previous layer's font/spacing).
  mc.font = `${td.italic ? 'italic' : 'normal'} ${td.fontWeight || 400} ${fontSize}px ${td.fontFamily || 'sans-serif'}`;
  // Letter spacing (canvas-local px, space after each glyph — same semantics
  // as CSS letter-spacing). Affects measureText, so wrapping stays consistent.
  if ('letterSpacing' in mc) mc.letterSpacing = `${td.letterSpacing || 0}px`;
  mc.textAlign = 'left';

  // Probe with the first REAL line so CJK/fallback glyph metrics (which
  // dominate the DOM line box) are reflected, not just the primary Latin
  // font's. Fallback ratio approximates the content area when the browser
  // does not expose fontBoundingBox metrics.
  const probeText = (td.content || '').split('\n').find(l => l.trim()) || 'Hg';
  const probe = mc.measureText(probeText);
  const fbAsc = probe.fontBoundingBoxAscent || fontSize * 0.8;
  const fbDesc = probe.fontBoundingBoxDescent || fontSize * 0.2;
  const halfLeading = (lineH - (fbAsc + fbDesc)) / 2;
  const firstBaselineTop = padY + halfLeading;

  const paragraphs = (td.content || '').split('\n');
  const maxWidth = wrapMode ? (td.boxWidth || boxW) - padX * 2 : undefined;

  // Fixed-mode vertical alignment: shift the whole content block down so its
  // first line sits centered/bottom-aligned in the box (never negative —
  // overflowing content stays top-anchored, mirroring the CSS clip box).
  // Trailing empty paragraphs are EXCLUDED from the visible content height:
  // the contenteditable keeps an invisible trailing line box (persistent
  // <br>), and centering that would push the real text half a line high.
  // auto_width/auto_height boxes hug the content, so there is nothing to align.
  let vAlignOffset = 0;
  // Wrapped paragraphs, computed lazily and shared by the fixed-mode content
  // height measurement AND the line assembly loop below — wrapping each
  // paragraph twice ran the identical word-split + Canvas2D measure pass two
  // full times (hot path for every fixed-box text layer per layout).
  let wrappedParagraphs: string[][] | null = null;
  const wrapped = () =>
    (wrappedParagraphs ??= paragraphs.map((paragraph) => wrapText(mc, paragraph, maxWidth!)));
  if (clipToBox) {
    const perParagraph = wrapped();
    let visibleEnd = perParagraph.length;
    while (visibleEnd > 0 && perParagraph[visibleEnd - 1].every((l) => !l.trim())) {
      visibleEnd--;
    }
    const totalLines = perParagraph
      .slice(0, visibleEnd)
      .reduce((sum, lines) => sum + lines.length, 0);
    const contentH = totalLines * lineH;
    const availH = boxH - padY * 2;
    const verticalAlign = td.verticalAlign || 'top';
    if (verticalAlign === 'middle') vAlignOffset = Math.max(0, (availH - contentH) / 2);
    else if (verticalAlign === 'bottom') vAlignOffset = Math.max(0, availH - contentH);
  }

  const underlines: TextDecorationRect[] = [];
  const strikethroughs: TextDecorationRect[] = [];
  const thickness = Math.max(1, Math.round(fontSize / 16));
  const lines: TextLineLayout[] = [];
  let clipped = false;

  const pushLine = (text: string, baselineY: number) => {
    const width = mc.measureText(text).width;
    const x =
      td.align === 'center'
        ? boxW / 2 - width / 2
        : td.align === 'right'
          ? boxW - padX - width
          : padX;
    // Per-character left edges via cumulative prefix measurement: the advance
    // of the first i code points (kerning + letterSpacing included) is the
    // browser's ink origin for character i. Array.from walks code points so
    // surrogate pairs advance as one glyph slot.
    const chars = Array.from(text);
    const charX: number[] = new Array(chars.length);
    let prefix = '';
    for (let i = 0; i < chars.length; i++) {
      charX[i] = x + mc.measureText(prefix).width;
      prefix += chars[i];
    }
    lines.push({ text, x, baselineY, width, charX });
    if (td.underline) {
      underlines.push({ x, y: baselineY + fontSize * 0.12, w: width, h: thickness });
    }
    if (td.strikethrough) {
      strikethroughs.push({ x, y: baselineY - fontSize * 0.3, w: width, h: thickness });
    }
  };

  if (wrapMode && maxWidth) {
    const perParagraph = wrapped();
    let lineTop = firstBaselineTop + vAlignOffset;

    outer: for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
      for (const line of perParagraph[pIdx]) {
        if (clipToBox && lineTop >= boxH) {
          clipped = true;
          break outer;
        }
        pushLine(line, lineTop + fbAsc);
        lineTop += lineH;
      }
    }
  } else {
    for (let i = 0; i < paragraphs.length; i++) {
      pushLine(paragraphs[i], firstBaselineTop + fbAsc + i * lineH);
    }
  }

  return {
    lines,
    underlines,
    strikethroughs,
    lineHeight: lineH,
    fontAscent: fbAsc,
    fontDescent: fbDesc,
    halfLeading,
    clipped,
    vAlignOffset,
  };
}
