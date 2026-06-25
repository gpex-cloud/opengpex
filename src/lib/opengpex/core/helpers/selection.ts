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

import type { Frame, LocalShape, LocalPolygon, LocalSpatial } from '@opengpex/editor/core/types';
import { isPolygon } from '@opengpex/editor/core/types';

/**
 * getRegularClipShape — convenience wrapper over `getClipBox` that returns
 * the active selection ONLY when it is a regular (rect/ellipse) LocalShape.
 *
 * Delegates entirely to `getClipBox(frame)` which reads `frame.latestClipTool`
 * as the single source of truth. No more blind-scanning of slot arrays.
 *
 * Returns `undefined` when no valid regular clip shape is active (either the
 * active tool is irregular, or the slot is empty/zero-sized).
 */
export function getRegularClipShape(frame: { latestClipTool?: string; clipBoxes: Record<string, LocalShape | LocalPolygon> }): LocalShape | undefined {
  const box = getClipBox(frame as Frame);
  return box?.regular ? box.spatial : undefined;
}

/**
 * getClipBox — unified selection resolver for clip commands.
 *
 * Reads `frame.latestClipTool` to determine which slot in `frame.clipBoxes`
 * holds the active selection, wraps the result in a `LocalSpatial`
 * discriminated union so callers can branch on `result.regular` without
 * needing to import `isPolygon`.
 *
 * Returns `null` when no valid selection exists (empty/zero-size for
 * LocalShape, or missing slot), which signals callers to take the
 * "no selection" branch.
 *
 * @example
 * ```ts
 * const box = getClipBox(frame);
 * if (!box) return; // no active selection
 * if (box.regular) {
 *   // box.spatial is narrowed to LocalShape
 *   applyRectCrop(box.spatial.rect);
 * } else {
 *   // box.spatial is narrowed to LocalPolygon
 *   applyPolygonMask(box.spatial.rings);
 * }
 * ```
 */
export function getClipBox(frame: Frame): LocalSpatial | null {
  const clipToolId = frame.latestClipTool || 'rect';

  // Guard: legacy imported data may not have clipBoxes at all.
  const entry = frame.clipBoxes?.[clipToolId] ?? null;
  if (!entry) return null;

  if (!isPolygon(entry)) {
    // Guard: legacy entries may be missing the rect field.
    if (!entry.rect) return null;
    // LocalShape — validate non-zero dimensions
    if (entry.rect.w <= 0 || entry.rect.h <= 0) return null;
    return { regular: true, spatial: entry };
  }
  // LocalPolygon — trust that it has valid points
  return { regular: false, spatial: entry };
}
