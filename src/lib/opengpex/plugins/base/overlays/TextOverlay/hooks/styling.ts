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
 * Text styling policy — the single owner of the text style field catalog.
 *
 * Every per-field concern derives from this module instead of being
 * hand-copied at its consumer:
 * - pendingTextData routing (pre-edit style persistence in CraftDrawer)
 *   → `pickStyleFields`;
 * - editing-session dirty checking → session.ts walks TEXT_STYLE_FIELDS;
 * - new-layer creation defaults → TEXT_STYLE_DEFAULTS / TEXT_DEFAULT_LINE_HEIGHT;
 * - the "re-measure the box" trigger set → LAYOUT_AFFECTING_FIELDS.
 *
 * Intentionally NOT consumed by the core engine: textLayout.ts and the
 * TextCaretKit keep their own literal fallbacks (e.g. lineHeight 1.4) because
 * core/widgets must not depend on the plugin layer — this catalog is the
 * model-layer source of truth those mirrors exist for.
 */

import type { TextLayerData } from '@opengpex/editor/core/types/models';
import type { PendingTextData } from '../../../drawers/CraftDrawer/protocols';

/** Line height used when the user has not chosen one. */
export const TEXT_DEFAULT_LINE_HEIGHT = 1.4;

/**
 * The text style fields, catalog order. This one list drives every per-field
 * walk (pending routing, session dirty checking), so adding a style field
 * means adding exactly one entry here (plus its default below and, when it
 * can change text metrics, one LAYOUT_AFFECTING_FIELDS entry).
 */
export const TEXT_STYLE_FIELDS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'align',
  'lineHeight',
  'letterSpacing',
  'verticalAlign',
  'italic',
  'underline',
  'strikethrough',
] as const;

export type TextStyleField = (typeof TEXT_STYLE_FIELDS)[number];

/**
 * Static default of every style field except fontSize: the size default is
 * canvas-adaptive (user's explicit preference, else getReferenceFontSize), so
 * it has no static value here and is resolved at its two consumer sites (the
 * CraftDrawer panel synthesis and the text-place creation path).
 */
export const TEXT_STYLE_DEFAULTS = {
  fontFamily: 'Inter',
  fontWeight: 400,
  align: 'left',
  lineHeight: TEXT_DEFAULT_LINE_HEIGHT,
  letterSpacing: 0,
  verticalAlign: 'top',
  italic: false,
  underline: false,
  strikethrough: false,
} as const satisfies Omit<Required<PendingTextData>, 'fontSize'>;

/**
 * Full style fallback including fontSize — the panel's synthesis base when
 * neither a stored preference nor a target layer exists.
 */
export const DEFAULT_TEXT_STYLE: Required<PendingTextData> = {
  fontSize: 24,
  ...TEXT_STYLE_DEFAULTS,
};

/**
 * Fields whose change can alter the measured text box (glyph metrics, wrap
 * widths, line pitch). Drives the editing-session "re-measure on style
 * change" trigger. align/verticalAlign shift or align content INSIDE the box
 * rather than resizing it, and italic/underline/strikethrough decorate
 * without changing advances — none of them re-measure.
 */
const LAYOUT_AFFECTING_FIELDS: readonly TextStyleField[] = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
];

export function affectsTextStyleLayout(key: TextStyleField): boolean {
  return LAYOUT_AFFECTING_FIELDS.includes(key);
}

/**
 * Compact signature over the layout-affecting style fields of a textData —
 * the re-measure trigger key for a live editing session: it changes exactly
 * when a style change may have altered the measured box, and stays stable
 * across decorative-only changes (italic, underline, …).
 */
export function textLayoutSignature(td: Partial<TextLayerData> | undefined): string {
  const source = td as Partial<Record<TextStyleField, unknown>> | undefined;
  return LAYOUT_AFFECTING_FIELDS.map((key) => String(source?.[key] ?? '')).join('\u0000');
}

/**
 * Extracts the style fields present in a textData patch — the single routing
 * rule for persisting style changes into pendingTextData (CraftDrawer's
 * pre-edit style persistence). Non-style fields (content, color, boxMode,
 * boxWidth/boxHeight) never route there; color is owned by ColorOptions.
 */
export function pickStyleFields(patch: Partial<TextLayerData>): Partial<PendingTextData> {
  const source = patch as Partial<Record<TextStyleField, unknown>>;
  const out: Partial<PendingTextData> = {};
  const target = out as Record<TextStyleField, unknown>;
  for (const key of TEXT_STYLE_FIELDS) {
    if (source[key] !== undefined) target[key] = source[key];
  }
  return out;
}
