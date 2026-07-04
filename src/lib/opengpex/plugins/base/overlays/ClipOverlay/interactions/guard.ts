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

import { InteractionEvent } from '@opengpex/editor/core/types';
import {
  ClipOptionsAPI,
  CROP_TOOL_STRATEGIES,
  CropTool,
  CropToolStrategy,
} from '../../../options/ClipOptions/protocols';

/**
 * makeCropToolGuard — Strategy-driven handler dispatch helper.
 *
 * Returns `true` exactly when the editor is in clip mode AND the active
 * cropTool's `handlerKind` matches `targetKind`. Each handler uses one such
 * guard at the head of its `test()` so that:
 *   1. all "is this my pointer event?" branching consults the same Strategy
 *      table (Single Source of Truth in `protocols.ts`);
 *   2. adding a new clip tool requires zero changes here — only adding a row
 *      to `CROP_TOOL_STRATEGIES` plus (optionally) a new handler factory.
 */
export function makeCropToolGuard(targetKind: CropToolStrategy['handlerKind']) {
  return (e: InteractionEvent): boolean => {
    // ─── Mode admission ────────────────────────────────────────────────
    // Re-Canvas operates as a *fully orthogonal* modal on top of pan
    // (2026-06-23 rework). When it's active the user expects the canvas
    // rect to be draggable & resizable just like in clip mode, so we must
    // admit pointer events even though `interactionMode === 'pan'`. But
    // *only* for the `clipbox` handlerKind — lasso / wand are strictly
    // clip-mode concerns (Re-Canvas is rectangular-only by definition).
    const inClip = e.state.interaction.interactionMode === 'clip';
    const inReCanvas = !!e.state.getStateSignal(ClipOptionsAPI.signals.reCanvas);
    if (!inClip && !(inReCanvas && targetKind === 'clipbox')) return false;

    // ─── Tool admission ────────────────────────────────────────────────
    // During Re-Canvas, regardless of the user's *previously selected*
    // clip tool (could be lasso / wand / ellipse), we want the rect
    // clipbox handler to dispatch — so synthesize `'rect'` as the active
    // tool here. This mirrors the synthesis done in `ClipOverlay/hooks.ts`
    // for the rendering side.
    const rawTool = (e.activeFrame?.latestClipTool as CropTool) || 'rect';
    const effectiveTool: CropTool = inReCanvas ? 'rect' : rawTool;
    return CROP_TOOL_STRATEGIES[effectiveTool].handlerKind === targetKind;
  };
}
