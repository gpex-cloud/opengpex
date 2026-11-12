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

import { InteractionEvent, InteractionHandler } from '@opengpex/editor/core/types';
import { readPeelSession } from '../peel/session';
import { isPeelSettleInFlight } from '../peel/controller';

/**
 * Whether a peel commit is baking right now: the session record says
 * 'committing' AND the settle lock is held. The status alone is not enough —
 * a mid-commit value can outlive a page refresh as residue, and freezing the
 * stage on residue would lock the canvas with nothing in flight to release it.
 */
export function isPeelCommitBaking(frame: InteractionEvent['activeFrame'] | null | undefined): boolean {
  return isPeelSettleInFlight() && readPeelSession(frame)?.status === 'committing';
}

/**
 * createCommitFreezeHandler — swallows every stage press while a peel commit
 * is baking.
 *
 * The commit composites the fragment as it stood when Enter was pressed and
 * lands the product there. The bake is a real GPU round trip, and during it
 * the selection handlers would still answer: a drag would slide the
 * selection away from the product about to land under it, a click outside
 * would clear it, a fresh draw would replace it. None of that can be
 * honoured — the pixels are already decided — so for the length of the bake
 * the stage is simply inert: the press is claimed here and does nothing.
 *
 * It outranks every clip handler and declares all three spring channels, so
 * a held Cmd / Shift / Alt cannot route the press around it to the global
 * layer-move fallback. Real UI controls (buttons, inputs, anything tagged
 * `data-role="ui"`) are left alone.
 */
export const createCommitFreezeHandler = (): InteractionHandler => ({
  id: 'clip-commit-freeze',
  priority: 140,
  springOverride: ['meta', 'shift', 'alt'],

  test: (e: InteractionEvent): boolean => {
    if (!isPeelCommitBaking(e.activeFrame)) return false;
    const target = e.nativeEvent.target as HTMLElement | null;
    return !target?.closest?.('button, a, input, [data-role="ui"], [contenteditable]');
  },

  onStart: () => undefined,
  onMove: () => undefined,
  onEnd: () => undefined,
});
