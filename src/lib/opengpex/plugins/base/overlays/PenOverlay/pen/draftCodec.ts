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
 * draftCodec.ts — the pen tool's Frame.drafts payload contract.
 *
 * Registered through `contributions.state.draftCodec`, this codec is what
 * makes `frame.drafts.pen` a typed, guarded channel instead of an opaque
 * bucket: it validates every hydrated payload (a malformed draft from an
 * unknown build evaporates at load), provides a hand-rolled point-by-point
 * clone for the hot gesture path (placing/dragging anchors clones the whole
 * draft once per gesture — the generic structuredClone traversal would scan
 * every handle object on every press), and routes the payload through the
 * viewport D4 transform so the draft stays aligned with the pixels across
 * canvas rotate/flip.
 */

import type { DraftCodec } from '@opengpex/editor/core/state/drafts';
import { mapPathAnchors } from '@opengpex/editor/core/geometry/public';
import type { PenAnchor, PenSubPath, Point2D } from '@opengpex/editor/core/types';
import type { PenDraft } from './penState';

/** Structural guard: a payload that fails this is treated as "no draft". */
function validatePenDraft(v: unknown): PenDraft | null {
  if (!v || typeof v !== 'object') return null;
  const subpaths = (v as { subpaths?: unknown }).subpaths;
  if (!Array.isArray(subpaths)) return null;
  for (const sub of subpaths) {
    if (!sub || typeof sub !== 'object') return null;
    const anchors = (sub as { anchors?: unknown }).anchors;
    if (!Array.isArray(anchors)) return null;
    for (const a of anchors) {
      const anchor = a as PenAnchor | null;
      if (!anchor || typeof anchor !== 'object') return null;
      if (typeof anchor.x !== 'number' || typeof anchor.y !== 'number') return null;
    }
  }
  return v as PenDraft;
}

/**
 * Hand-rolled deep copy (the R1b working clone). Mirrors the gesture
 * snapshot helper: anchors are copied point-by-point, handle objects are
 * fresh, subpath order and closed flags carry over. Note the clone hands
 * out the SAME handle object when null — handles are `{x,y}|null`, so null
 * travels for free.
 */
function clonePenDraft(draft: PenDraft): PenDraft {
  return {
    subpaths: draft.subpaths.map((s) => ({
      closed: s.closed,
      anchors: s.anchors.map((a) => ({
        x: a.x, y: a.y,
        handleIn: a.handleIn ? { ...a.handleIn } : a.handleIn,
        handleOut: a.handleOut ? { ...a.handleOut } : a.handleOut,
      })),
    })),
  };
}

/**
 * The D4 symmetry POINT map, expressed against the PRE-transform canvas
 * (same formulas transformFrame applies to layer poses and selection
 * polygons): rotate 90° maps onto the transposed canvas, flips mirror an
 * axis. Implemented locally because plugin code may not import core
 * geometry operators directly — the codec hook is the sanctioned seam.
 * The anchor+handle machinery itself is NOT re-implemented here: handles
 * ride `mapPathAnchors` (the public-whitelist L0 primitive), which maps
 * each handle's absolute endpoint and re-bases it against the mapped
 * anchor — for the affine D4 maps that is exactly the handle vector
 * transformed by the rotation/flip's linear part.
 */
function mapDraftPoint(p: Point2D, container: { w: number; h: number }, op: string): Point2D {
  const { w, h } = container;
  switch (op) {
    case 'rotate_r': return { x: h - p.y, y: p.x };
    case 'rotate_l': return { x: p.y, y: w - p.x };
    case 'flip_h': return { x: w - p.x, y: p.y };
    case 'flip_v': return { x: p.x, y: h - p.y };
    default: return { x: p.x, y: p.y };
  }
}

export const penDraftCodec: DraftCodec<PenDraft> = {
  toolId: 'pen',
  validate: validatePenDraft,
  clone: clonePenDraft,
  transform: (draft, container, operation) => ({
    subpaths: mapPathAnchors(
      { paths: draft.subpaths },
      (p) => mapDraftPoint(p, container, operation),
    ).paths as PenSubPath[],
  }),
};
