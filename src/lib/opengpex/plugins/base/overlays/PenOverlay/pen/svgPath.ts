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
 * svg.ts — Local SVG `d` serializer for pen paths, for OVERLAY RENDERING only.
 *
 * The L0 `penPathToSvgD` operator lives behind the GeometryService boundary
 * (plugins must not import geometry operators directly), and the overlay
 * renderer is a pure string builder without service access — so the small
 * M/L/C/Z writer is duplicated here deliberately. Commit paths (mask /
 * selection) use the service's serializer; if the two ever disagree, the
 * service one wins.
 */

import type { PenAnchor, PenPathData, Point2D } from '@opengpex/editor/core/types';

/** Resolves a relative handle slot to an absolute control point (null → anchor). */
function handleToAbs(anchor: PenAnchor, h: { x: number; y: number } | null | undefined): Point2D {
  return h ? { x: anchor.x + h.x, y: anchor.y + h.y } : { x: anchor.x, y: anchor.y };
}

const fmtNum = (v: number): string => String(parseFloat(v.toFixed(3)));

/** Serializes a pen path to an absolute-command SVG `d` string (M/L/C/Z). */
export function penPathToSvgD(path: PenPathData): string {
  const parts: string[] = [];
  for (const sub of path.paths) {
    const a = sub.anchors;
    if (a.length === 0) continue;
    if (a.length === 1) {
      parts.push(`M ${fmtNum(a[0].x)} ${fmtNum(a[0].y)}`);
      continue;
    }
    parts.push(`M ${fmtNum(a[0].x)} ${fmtNum(a[0].y)}`);
    const count = sub.closed ? a.length : a.length - 1;
    for (let i = 0; i < count; i++) {
      const from = a[i];
      const to = a[(i + 1) % a.length];
      const c1 = handleToAbs(from, from.handleOut);
      const c2 = handleToAbs(to, to.handleIn);
      parts.push(`C ${fmtNum(c1.x)} ${fmtNum(c1.y)} ${fmtNum(c2.x)} ${fmtNum(c2.y)} ${fmtNum(to.x)} ${fmtNum(to.y)}`);
    }
    if (sub.closed) parts.push('Z');
  }
  return parts.join(' ');
}
