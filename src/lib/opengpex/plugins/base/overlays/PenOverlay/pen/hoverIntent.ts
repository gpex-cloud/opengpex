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
 * hoverIntent.ts — Pure resolver: "what will a plain press do here?"
 *
 * The draw handler's press routing and the lifecycle's hover cursor must
 * agree on the same answer, so the decision is written ONCE as a pure
 * function over the state machine view plus the two hit results the caller
 * already computed (nearest anchor/handle, nearest segment). The order of
 * the rungs mirrors the draw handler's onStart exactly: close → resume →
 * element under the pointer (Alt convert / handle / just-placed anchor /
 * any other anchor) → segment → place (continue or start a new subpath).
 */

import type { Point2D } from '@opengpex/editor/core/types';
import { hitFrozenSubpathEnd, type PenSelection, type PenToolState } from './penState';

export type PenHoverIntent =
  | 'continue'       // place the next anchor of the open subpath (base cursor)
  | 'new-path'       // place the first anchor of a NEW subpath
  | 'close'          // close the open subpath onto its first anchor
  | 'resume'         // resume a frozen open subpath from its end anchor
  | 'add-point'      // insert an anchor on the hovered segment
  | 'remove-point'   // delete the hovered anchor
  | 'convert'        // Alt convert, or retract the just-placed anchor's out-handle
  | 'direct-select'; // drag the hovered control handle

/** The anchor/handle under the pointer (as `bezier.nearestPathAnchor` reports it). */
export type PenElementHit = Pick<PenSelection, 'pathIdx' | 'anchorIdx' | 'kind'>;

export function resolveDraftHoverIntent(
  state: PenToolState,
  pt: Point2D,
  tol: number,
  elementHit: PenElementHit | null,
  segmentHit: boolean,
  altHeld: boolean,
): PenHoverIntent {
  const subs = state.draft?.subpaths ?? [];
  const last = subs[subs.length - 1];
  const lastIdx = subs.length - 1;

  // Close: the receptive open subpath's first anchor with ≥3 anchors (the
  // same gate the press uses; a frozen tail still closes on its first anchor).
  if (last && !last.closed && last.anchors.length >= 3) {
    const first = last.anchors[0];
    if (Math.hypot(first.x - pt.x, first.y - pt.y) <= tol) return 'close';
  }

  // Resume: a frozen open subpath's end anchor.
  if (hitFrozenSubpathEnd(state, pt, tol) >= 0) return 'resume';

  if (elementHit) {
    if (altHeld) return 'convert';
    if (elementHit.kind !== 'anchor') return 'direct-select';
    // The just-placed anchor of the receptive tail: a click retracts its
    // outgoing handle (the next segment leaves straight) instead of deleting.
    const receptive = last && !last.closed && !state.frozen ? last : null;
    if (receptive && elementHit.pathIdx === lastIdx && elementHit.anchorIdx === receptive.anchors.length - 1) {
      return 'convert';
    }
    return 'remove-point';
  }

  if (segmentHit) return 'add-point';

  // Nothing under the pointer: the next press places an anchor. It extends
  // the open subpath when one is receptive; otherwise (closed tail, frozen
  // intent pending, empty session) it opens a new subpath.
  const receptiveOpen = !!last && !last.closed && !state.frozen && last.anchors.length > 0;
  return receptiveOpen ? 'continue' : 'new-path';
}
