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

import type { Frame, LocalShape, LocalPolygon } from '@opengpex/editor/core/types';

/**
 * resolveActiveSelection — unified selection resolver for clip commands.
 *
 * Given the active tool ID (from SIGNAL_CROP_TOOL), returns the appropriate
 * selection data from the frame:
 *   - irregular tools (lasso/wand/future): reads `irregularCropBoxes[toolId]`
 *   - regular tools (rect/ellipse/future): reads `imageCropBox`
 *
 * Returns `null` when no valid selection exists (empty/zero-size), which
 * signals callers to take the "no selection" branch.
 *
 * Design: accepts `toolId: string` (not a CropTool enum) so core layer
 * has zero coupling to the plugin-level tool registry. The routing logic
 * is purely data-driven: if the tool's slot exists in `irregularCropBoxes`,
 * use it; otherwise fall back to `imageCropBox`.
 */
export function resolveActiveSelection(
  frame: Frame,
  toolId: string | undefined
): LocalShape | LocalPolygon | null {
  // 1. Try irregular slot (keyed by toolId)
  if (toolId) {
    const irregular = frame.irregularCropBoxes?.[toolId] ?? null;
    if (irregular) return irregular;
  }

  // 2. Fall back to regular imageCropBox
  const box = frame.imageCropBox;
  if (box && box.rect.w > 0 && box.rect.h > 0) return box;

  return null;
}
