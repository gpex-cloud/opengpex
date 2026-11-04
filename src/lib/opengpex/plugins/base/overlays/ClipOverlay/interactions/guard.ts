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
import { readPeelSession } from '../peel/session';
import {
  ClipOptionsAPI,
  CLIP_TOOL_STRATEGIES,
  ClipTool,
  ClipToolStrategy,
} from '../../../options/ClipOptions/protocols';

/**
 * makeClipToolGuard — Strategy-driven handler dispatch helper.
 *
 * Returns `true` exactly when the editor is in clip mode AND the active
 * clipTool's `handlerKind` matches `targetKind`. Each handler uses one such
 * guard at the head of its `test()` so that:
 *   1. all "is this my pointer event?" branching consults the same Strategy
 *      table (Single Source of Truth in `protocols.ts`);
 *   2. adding a new clip tool requires zero changes here — only adding a row
 *      to `CLIP_TOOL_STRATEGIES` plus (optionally) a new handler factory.
 */
export function makeClipToolGuard(targetKind: ClipToolStrategy['handlerKind']) {
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
    // clip tool (could be lasso / wand), we want the rect
    // clipbox handler to dispatch — so synthesize `'rect'` as the active
    // tool here. This mirrors the synthesis done in `ClipOverlay/hooks.ts`
    // for the rendering side.
    const rawTool = (e.activeFrame?.latestClipTool as ClipTool) || 'rect';
    const effectiveTool: ClipTool = inReCanvas ? 'rect' : rawTool;
    return CLIP_TOOL_STRATEGIES[effectiveTool].handlerKind === targetKind;
  };
}

/**
 * discardPeelOnFreshDraw — call at the head of a selection tool's onStart:
 * a FRESH selection draw while a peel session is undecided is an implicit
 * CANCEL (Esc semantics — the fragment and its glued selection disappear),
 * after which the tool draws the replacement selection immediately. A
 * fresh draw in clip mode starts OUTSIDE the selection by construction
 * (presses inside are claimed by the move/transform handlers), and the
 * boolean-modifier drags (Shift/Alt add/subtract, Cmd peel family) keep
 * their own flows — only a plain draw cancels.
 */
export function discardPeelOnFreshDraw(e: InteractionEvent): void {
  const session = readPeelSession(e.activeFrame);
  const target = e.nativeEvent.target as HTMLElement | null;
  const scopeHit = !!target?.closest('[data-clip-selection-gizmo]');
  if (!session || session.status !== 'peeled') return;
  if (e.keys.shift || e.keys.alt || e.keys.meta) return;
  // A press on the session's own gizmo (handles, rotation dot, move
  // surface) belongs to the session transform handler — and the gizmo
  // handles of a rotated fragment float OUTSIDE the selection polygon, so
  // the press would otherwise read as a "fresh draw outside" and cancel
  // the session the user was trying to transform.
  if (scopeHit) return;
  void e.actions.executeCommand(ClipOptionsAPI.commands.resetBox.uid);
}
