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
 * Editing-session state policy. The session lifecycle itself (open / commit /
 * cancel with their undo semantics) lives in useInlineTextEditing; this module
 * owns the "did the session actually change anything" decision.
 */

import type { TextLayerData } from '@opengpex/editor/core/types/models';
import { measuredBoxesDiffer } from './measuring';
import { TEXT_STYLE_FIELDS, type TextStyleField } from './styling';
import type { TextEditingSession } from '../protocols';

/**
 * Whether an editing session's final state differs from its original
 * snapshot — the commit gate that decides between "no changes: exit with
 * zero undo impact" and "restore snapshot → undoable modify-commit".
 *
 * The style-field walk is derived from the styling catalog. The
 * hand-enumerated list this replaces had already drifted: letterSpacing and
 * verticalAlign were missing, so a change to either (with bounding and
 * content unchanged — the fixed-boxMode case) kept the live layer mutated
 * while the commit took the zero-undo-impact exit, leaving the change
 * without an undo checkpoint.
 *
 * Color is compared structurally (space / alpha / coords, NOT hex — hex is a
 * derived view), and the box trio (boxMode / boxWidth / boxHeight) is checked
 * explicitly: they are box structure, not catalog style fields.
 */
export function isSessionDirty(
  current: { bounding: { w: number; h: number }; textData: TextLayerData },
  original: NonNullable<TextEditingSession['originalSnapshot']>,
): boolean {
  // Bounding change — compared through the shared one-pixel measurement
  // tolerance. The snapshot may hold the canvas engine's answer while the
  // commit re-measures from the DOM (or vice versa); a one-pixel disagreement
  // between the two engines is rounding noise, and treating it as dirty made
  // a no-edit session commit land a phantom bounding-only undo step.
  if (measuredBoxesDiffer(current.bounding, original.bounding)) return true;
  // Content change
  if (current.textData.content !== original.textData.content) return true;
  // Style changes — every catalog field, one walk
  const c = current.textData as unknown as Record<TextStyleField, unknown>;
  const o = original.textData as unknown as Record<TextStyleField, unknown>;
  for (const key of TEXT_STYLE_FIELDS) {
    if (c[key] !== o[key]) return true;
  }
  // Color change
  if (
    current.textData.color.space !== original.textData.color.space ||
    current.textData.color.alpha !== original.textData.color.alpha ||
    current.textData.color.coords.r !== original.textData.color.coords.r ||
    current.textData.color.coords.g !== original.textData.color.coords.g ||
    current.textData.color.coords.b !== original.textData.color.coords.b
  ) return true;
  // Box structure change
  if (current.textData.boxMode !== original.textData.boxMode) return true;
  if (current.textData.boxWidth !== original.textData.boxWidth) return true;
  if (current.textData.boxHeight !== original.textData.boxHeight) return true;
  return false;
}
