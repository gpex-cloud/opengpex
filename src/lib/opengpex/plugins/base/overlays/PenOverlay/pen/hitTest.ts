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
  return findDraftSegmentHit(draft, pt, tolerance, ops) !== null;
}

/** Where a draft's curve passes nearest to `pt` (frame-local px). */
export interface DraftSegmentHit {
  pathIdx: number;
  segIdx: number;
  /** Parameter along the hit segment (de Casteljau split position). */
  t: number;
  dist: number;
}

/**
 * Locates the nearest point on a draft's bézier curves within `tolerance`
 * (frame-local px), returning the owning subpath, segment index and curve
 * parameter — the full address a segment insertion needs. Ties resolve to
 * the closest distance across all subpaths. Callers double the anchor
 * tolerance for segments (the committed-side convention: a segment is a
 * lower-value target than an anchor — the anchor scan runs first anyway).
 */
export function findDraftSegmentHit(draft: PenDraft, pt: Point2D, tolerance: number, ops: PenHitOps): DraftSegmentHit | null {
  let best: DraftSegmentHit | null = null;
  draft.subpaths.forEach((sub, pathIdx) => {
    if (sub.anchors.length < 2) return;
    const segs = ops.penPathToCubicSegments({ paths: [sub] });
    const near = ops.nearestPointOnPath(segs, pt, tolerance);
    if (!near) return;
    if (!best || near.dist < best.dist) best = { pathIdx, segIdx: near.segmentIndex, t: near.t, dist: near.dist };
  });
  return best;
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

/**
 * Which SUBPATH a Cmd press on the draft takes hold of (the black-arrow
 * "move this path component" read): the subpath whose curve passes within
 * `segmentTolerance` of `pt`, else the newest subpath whose own flattened
 * ring (open polylines implicitly closed) contains `pt`. Each ring is
 * judged alone — a point inside a hole ring still picks the hole, which is
 * the component the user is pointing at. Returns null when the press misses
 * every subpath.
 */
export function findDraftSubpathAt(draft: PenDraft, pt: Point2D, segmentTolerance: number, ops: PenHitOps): number | null {
  const seg = findDraftSegmentHit(draft, pt, segmentTolerance, ops);
  if (seg) return seg.pathIdx;
  for (let pi = draft.subpaths.length - 1; pi >= 0; pi--) {
    const segs = ops.penPathToCubicSegments({ paths: [draft.subpaths[pi]] });
    const ring = ops.flattenCubicChain(segs, 0.25);
    if (ring.length >= 3 && ops.isPointInPolygon(pt, [ring])) return pi;
  }
  return null;
}
