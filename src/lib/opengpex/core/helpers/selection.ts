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

import type { Frame, LocalPolygon } from '@opengpex/editor/core/types';

/**
 * getRegularClipShape — convenience wrapper over `getClipBox` that returns
 * the active selection ONLY when it is a regular (rect/ellipse) LocalPolygon
 * (i.e. a 4-point or 64-point polygon produced by the rect/ellipse tool).
 *
 * Delegates entirely to `getClipBox(frame)` which reads `frame.latestClipTool`
 * as the single source of truth. No more blind-scanning of slot arrays.
 *
 * Returns `undefined` when no valid clip polygon is active (slot is empty).
 */
export function getRegularClipShape(frame: { latestClipTool?: string; clipBoxes: Record<string, LocalPolygon> }): LocalPolygon | undefined {
  return getClipBox(frame as Frame) ?? undefined;
}

/**
 * getClipBox — unified selection resolver for clip commands.
 *
 * Reads `frame.latestClipTool` to determine which slot in `frame.clipBoxes`
 * holds the active selection and returns the `LocalPolygon` directly.
 *
 * All tool types (rect, ellipse, lasso, wand) now store a `LocalPolygon`.
 * Consumers that need a `LocalShape` for the rendering pipeline should call
 * `polygonToShape(box)` from `@opengpex/editor/core/helpers/path2d`.
 *
 * Returns `null` when no valid selection exists (missing slot).
 *
 * @example
 * ```ts
 * const box = getClipBox(frame);
 * if (!box) return; // no active selection
 * // box is LocalPolygon — use rings for mask, or polygonToShape for rendering
 * applyPolygonMask(box.rings);
 * ```
 */
export function getClipBox(frame: Frame): LocalPolygon | null {
  const clipToolId = frame.latestClipTool || 'rect';

  // Guard: legacy imported data may not have clipBoxes at all.
  const entry = frame.clipBoxes?.[clipToolId] ?? null;
  if (!entry) return null;

  // LocalPolygon — trust that it has valid points
  return entry;
}
