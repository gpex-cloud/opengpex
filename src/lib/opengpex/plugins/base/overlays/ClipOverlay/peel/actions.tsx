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

'use client';

import { CornerDownLeft, Scaling } from 'lucide-react';
import { useEditorServices } from '@opengpex/editor/core/context';
import * as P from '../protocols';
import { ClipOptionsAPI } from '../../../options/ClipOptions/protocols';

/**
 * PeelActionButtons — the two settlement affordances for a floating peel
 * fragment, drawn as their KEYS: revert (the literal "Esc" key label, red —
 * Escape semantics: restore the host, drop the fragment) on the left, settle
 * (CornerDownLeft = the Enter key, green — bake the fragment into its own
 * layer, host keeps the hole and the focus) on the right. Both route through
 * the SAME commands the keys fire, so the buttons are pure discoverability
 * and the glyphs themselves name the shortcut. In pan mode — where no
 * toolbar exit exists — this bar is the only visible settle/cancel
 * affordance.
 *
 * A third, conditional button resets the fragment SIZE (original pixels and
 * size, current position and rotation kept). It only appears once the
 * fragment has actually been scaled/rotated (`canResetSize`), so the bar
 * stays two buttons wide in the common case. It has no key: it routes to
 * the core command directly.
 *
 * Pointer hygiene: the bar lives inside the stage overlay, above the canvas.
 * `data-role="ui"` makes the clip gesture handlers stand down, and the
 * pointerdown is stopped at the root so the global layer-move fallback
 * (which does not inspect targets) never opens a transaction under a click
 * meant for a button.
 */
export function PeelActionButtons({ canResetSize = false }: { canResetSize?: boolean }) {
  const { actions } = useEditorServices();

  return (
    <div
      data-role="ui"
      className="flex items-center pointer-events-auto"
      style={{ gap: '2px' }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        title="Revert fragment (Esc)"
        aria-label="Revert fragment"
        className="flex items-center outline-none rounded px-1 text-[10px] font-bold leading-none text-rose-400 hover:bg-white/10"
        style={{ height: '16px' }}
        onClick={() => actions.executeCommand(ClipOptionsAPI.commands.exitClip.uid)}
      >
        Esc
      </button>
      {canResetSize && (
        <button
          type="button"
          title="Reset fragment size"
          aria-label="Reset fragment size"
          className="flex items-center outline-none rounded px-1 text-sky-400 hover:bg-white/10"
          style={{ height: '16px' }}
          onClick={() => actions.executeCommand(P.CMD_PEEL_RESET_TRANSFORM)}
        >
          <Scaling size={12} strokeWidth={2.5} />
        </button>
      )}
      <button
        type="button"
        title="Settle fragment (Enter)"
        aria-label="Settle fragment"
        className="flex items-center outline-none rounded px-1 text-emerald-400 hover:bg-white/10"
        style={{ height: '16px' }}
        onClick={() => actions.executeCommand(ClipOptionsAPI.commands.commitPeel.uid)}
      >
        <CornerDownLeft size={12} strokeWidth={2.5} />
      </button>
    </div>
  );
}
