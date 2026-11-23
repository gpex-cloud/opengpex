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
 * Clone Stamp Kernel (A4 — retouch family source-patch copy).
 *
 * Copies a feathered disk of pixels from the caller-chosen sample center of
 * the composited source onto the stamp patch. Alignment (the fixed offset
 * between the picked source anchor and the stroke start) is the SESSION's
 * concern — the kernel just receives `(cx, cy)` stamp center and `(sx, sy)`
 * sample center in source-buffer coordinates.
 *
 * Anti-self-feedback contract: the caller always passes the SESSION-START
 * composite snapshot as the source, never the live working buffer, so cloned
 * output can never feed a later stamp of the same stroke. (Across strokes
 * the previous stroke's bake is already committed, so the next session's
 * composite naturally sees it — Photoshop-aligned semantics.)
 *
 * Implementation contract (mirrors healKernel.ts / convKernel.ts):
 * - Pure CPU on plain RGBA buffers (ImageData-shaped), DOM-free, unit
 *   testable without canvas.
 * - Fully deterministic: no RNG; identical inputs produce identical patches.
 * - Reentrant: all working buffers are local to a call.
 * - The outer-rim smoothstep feather (opaque inside 0.6r, ramping to exactly
 *   0 at r) matches the family kernels so overlapping stamps chain into the
 *   working buffer without visible seams.
 */

import type { RgbaBuffer } from '../heal/healKernel';

/** Default hardness fraction: alpha stays fully opaque inside this fraction
 * of the brush radius, then smoothsteps to 0 at r. 0.75 (the panel Hardness
 * default) keeps overlapping stamp arcs reading as one smooth edge; the
 * panel slider maps [0..100] onto the full plateau range for soft→hard. */
const DEFAULT_FEATHER_INNER = 0.75;

export interface CloneStampParams {
  /** Composited source pixels the stamp copies FROM (the session-start snapshot). */
  source: RgbaBuffer;
  /** Stamp center (destination position), in the SOURCE buffer's coordinate space. */
  cx: number;
  cy: number;
  /** Sample center (source position the pixels are copied from), same coordinate space. */
  sx: number;
  sy: number;
  /** Stamp (brush) radius in source-buffer pixels. */
  radius: number;
  /**
   * Hardness fraction [0..1]: fraction of the radius that stays fully opaque
   * before the smoothstep ramp to 0 at r. 1 = hard edge (fully opaque to the
   * rim, only the pixel-grid AA remains); 0 = fully soft. Defaults to
   * DEFAULT_FEATHER_INNER when omitted.
   */
  hardness?: number;
}

export interface CloneStampResult {
  /** Square straight-alpha RGBA patch covering the stamp bounding box, side = size. */
  data: Uint8ClampedArray;
  /** Side length of the square patch in pixels (2 * ceil(radius)). */
  size: number;
}

/** Smoothstep in [0,1] over edge0..edge1 (clamped). Same curve as CSS easing. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Copies one feathered clone patch. Pixels outside the source bounds read as
 * fully transparent (copying from past the canvas edge must not fabricate
 * opaque content).
 */
export function cloneStamp(params: CloneStampParams): CloneStampResult {
  const { source, cx, cy, sx, sy, radius } = params;
  const half = Math.ceil(radius);
  const size = half * 2;
  const out = new Uint8ClampedArray(size * size * 4);

  if (!(radius > 0.5) || size <= 0) {
    return { data: out, size };
  }

  const sW = source.width;
  const sH = source.height;
  const c = size / 2;
  const hardness = Math.min(1, Math.max(0, params.hardness ?? DEFAULT_FEATHER_INNER));
  // Unified edge profile: ONE smoothstep for every hardness. The ramp width
  // scales with softness but is clamped to a minimum ~0.75px band even at
  // hardness 1 — a hard edge is "plateau to rim + narrow S-curve AA", never a
  // linear cut (avoids the curvature jump and the jagged binary staircase).
  const rampWidth = Math.max(0.75, radius * (1 - hardness));
  const inner = Math.max(0, radius - rampWidth);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      // hardness 1 → inner === radius: fully opaque to the rim with a 1px
      // linear anti-alias tail (a binary cut would leave a jagged staircase;
      // the 1px tail is the same AA insurance the rasterizer provides for
      // vector strokes). Guard the smoothstep's zero-width ramp explicitly.
      const a = d >= radius || inner >= radius
        ? (d < radius ? 255 : 0)
        : 255 * (1 - smoothstep(inner, radius, d));
      if (a <= 0) continue; // leave RGB at 0 where alpha is 0

      // Patch pixel (x,y) maps to source stamp position (cx-half+x, cy-half+y)
      // and sample position (sx-half+x, sy-half+y).
      const px = Math.round(cx) - half + x;
      const py = Math.round(cy) - half + y;
      if (px < 0 || py < 0 || px >= sW || py >= sH) continue;
      const sxp = Math.round(sx) - half + x;
      const syp = Math.round(sy) - half + y;
      if (sxp < 0 || syp < 0 || sxp >= sW || syp >= sH) continue;

      const si = (syp * sW + sxp) * 4;
      const oi = (y * size + x) * 4;
      out[oi] = source.data[si];
      out[oi + 1] = source.data[si + 1];
      out[oi + 2] = source.data[si + 2];
      out[oi + 3] = Math.min(source.data[si + 3], a);
    }
  }

  return { data: out, size };
}
