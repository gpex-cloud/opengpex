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
 * Selection boolean combine helper (P5).
 *
 * While drawing a new selection, holding Shift unions it with the existing
 * selection and Alt subtracts the new shape from it (Photoshop marquee
 * semantics). The boolean math runs on the shared polygon-clipping worker so
 * arbitrarily complex ring sets stay off the main thread.
 *
 * Both operands must be frame-local LocalPolygons. The result inherits the
 * BASE selection's antiAliased entity flag: an existing selection keeps its
 * own edge treatment no matter which tool drew the incoming shape (same rule
 * the AA toggle has always followed across tool switches).
 */

import {
  LocalPoint,
  LocalPolygon,
  asLocalPoint,
  asLocalPolygon,
  asLocalRect,
} from '@opengpex/editor/core/types';
import { clipComputeClient } from '../../../options/ClipOptions/workers/client';
import type { PolyBoolOp } from '@opengpex/editor/core/geometry/poly-bool';

/** Minimal slice of GeometryService used to rebuild the result bbox. */
interface PolygonBoundsService {
  polygon: {
    computePolygonBounds(rings: { x: number; y: number }[][]): { x: number; y: number; w: number; h: number };
  };
}

/**
 * Resolve the boolean operation from pointer-event modifier keys.
 * Shift wins over Alt when both are held. Returns null when neither modifier
 * means "combine with the existing selection" (plain replace semantics).
 */
export function booleanOpFromModifiers(shiftKey: boolean, altKey: boolean): PolyBoolOp | null {
  if (shiftKey) return 'union';
  if (altKey) return 'difference';
  return null;
}

/**
 * Combine the freshly drawn polygon with the existing selection.
 * Returns null when the boolean result is empty (e.g. Alt-subtracted the
 * whole selection) — the caller writes `confinement: null` in that case.
 */
export async function combineWithSelection(
  base: LocalPolygon,
  incoming: LocalPolygon,
  op: PolyBoolOp,
  geometry: PolygonBoundsService
): Promise<LocalPolygon | null> {
  const toPoint2D = (poly: LocalPolygon) =>
    poly.rings.map(ring => ring.map(p => ({ x: p.x, y: p.y })));

  const resp = await clipComputeClient.runBoolean({
    op,
    base: toPoint2D(base),
    incoming: toPoint2D(incoming),
  });

  if (resp.error || !resp.rings || resp.rings.length === 0) {
    return null;
  }

  const rings = resp.rings.map(ring => ring.map(p => asLocalPoint(p)));
  const bounds = geometry.polygon.computePolygonBounds(rings);
  return asLocalPolygon(
    rings as LocalPoint[][],
    asLocalRect(bounds),
    base.antiAliased ?? true,
    base.ssdepMode ?? false
  );
}

/**
 * Live boolean preview streamer for streaming create gestures (rect /
 * pathellipse). While the user drags with Shift/Alt held, each throttled tick
 * combines the BASE selection with the in-progress shape and writes the
 * RESULT into the gesture transaction — so the marching ants show the real
 * union/difference as it forms, instead of the raw drag shape briefly
 * replacing the existing selection (the boolean only materializing on
 * pointer-up).
 *
 * Leading + trailing throttle (~60ms): the worker roundtrip is a few
 * milliseconds, but pointermove fires at frame rate; each newer tick
 * supersedes stale results via a token, and writes are skipped once the
 * transaction is no longer active (gesture ended or cancelled).
 */
export function createLiveBooleanPreview() {
  let token = 0;
  let lastEmitAt = 0;

  return (params: {
    base: LocalPolygon;
    incoming: LocalPolygon;
    op: PolyBoolOp;
    geometry: PolygonBoundsService;
    tx: { isActive: boolean; update: (patch: { confinement: LocalPolygon | null }, channel: 'frame') => void };
  }): void => {
    const my = ++token;
    const emit = () => {
      combineWithSelection(params.base, params.incoming, params.op, params.geometry).then((combined) => {
        if (my !== token || !params.tx.isActive) return;
        params.tx.update({ confinement: combined }, 'frame');
      });
    };
    const now = Date.now();
    const gap = now - lastEmitAt;
    if (gap >= 60) {
      lastEmitAt = now;
      emit();
    } else {
      setTimeout(() => {
        if (my !== token) return;
        lastEmitAt = Date.now();
        emit();
      }, 60 - gap);
    }
  };
}
