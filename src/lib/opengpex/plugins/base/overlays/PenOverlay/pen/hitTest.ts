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
 * hitTest.ts — The pen's draft hit tests (the anchor-element query lives in
 * the L0 layer as `bezier.nearestPathAnchor`):
 *
 * - `hitTestDraftSegment` — a draft's bézier curves (whole-draft drag outline).
 * - `hitTestDraftArea`    — a draft's enclosed area (whole-drag interior).
 *
 * All coordinates are in the payload's own space (frame-local for the draft,
 * layer-local for committed paths) — callers map the pointer first. The L0
 * flattening/curve ops arrive injected (`PenHitOps`, satisfied by
 * `geometry.bezier` + `geometry.polygon`): plugins must not import the
 * internal geometry operators directly.
 */

import type { CubicSegment, PenPathData, Point2D } from '@opengpex/editor/core/types';
import type { PenDraft } from './penState';

/** The L0 ops the curve/area hit tests need (see module doc for injection). */
export interface PenHitOps {
  penPathToCubicSegments(path: PenPathData): CubicSegment[];
  nearestPointOnPath(path: readonly CubicSegment[], pt: Point2D, tolerance: number): { t: number; dist: number; segmentIndex: number } | null;
  flattenCubicChain(segments: readonly CubicSegment[], toleranceDocPx: number): Point2D[];
  isPointInPolygon(point: Point2D, rings: Point2D[][]): boolean;
}


/**
 * Hit-tests a DRAFT's segments: true when any bézier curve of any subpath
 * passes within `tolerance` (frame-local px) of `pt`. This is the outline
 * half of the whole-draft drag target (see {@link hitTestDraftArea} for the
 * interior half). Callers double the anchor tolerance for segments (the
 * committed-side convention: a segment is a lower-value target than an
 * anchor — the anchor scan runs first anyway).
 */
export function hitTestDraftSegment(draft: PenDraft, pt: Point2D, tolerance: number, ops: PenHitOps): boolean {
  for (const sub of draft.subpaths) {
    if (sub.anchors.length < 2) continue;
    const segs = ops.penPathToCubicSegments({ paths: [sub] });
    if (ops.nearestPointOnPath(segs, pt, tolerance)) return true;
  }
  return false;
}

/**
 * Hit-tests a DRAFT's enclosed area: true when `pt` falls inside the
 * flattened polygon of the draft — ALL subpaths' rings judged together in a
 * single even-odd pass, the same rule the renderer fills them by (overlapping
 * subpaths cancel, matching what the user sees). An OPEN polyline is tested
 * against its implicitly closed area (the flatten's polygon wraps the last
 * point back to the first), so "inside" works whether the path is closed or
 * not. Subpaths that flatten to fewer than 3 points (a lone segment) enclose
 * no area and never hit here — {@link hitTestDraftSegment} covers their
 * outline. The flatten tolerance matches the commit pipeline (0.25 doc px).
 */
export function hitTestDraftArea(draft: PenDraft, pt: Point2D, ops: PenHitOps): boolean {
  const rings: Point2D[][] = [];
  for (const sub of draft.subpaths) {
    const segs = ops.penPathToCubicSegments({ paths: [sub] });
    const ring = ops.flattenCubicChain(segs, 0.25);
    if (ring.length >= 3) rings.push(ring);
  }
  return rings.length > 0 && ops.isPointInPolygon(pt, rings);
}
