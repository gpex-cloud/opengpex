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
 * oversizedTransient.ts — the ONE threshold that routes a compositor transient
 * either through the POT `TexturePool` or around it.
 *
 * WHY A THRESHOLD: the pool was designed for bucketed layer
 * boxes. Its POT ladder tops out at 4096 and its idle-cache budget
 * (`maxFreeBytes`) is device-tuned to hold a handful of those. A full-canvas /
 * oversized transient snaps to the next POT (a 5000-wide frame → 8192), so a
 * single `rgba16float` block is 8192×8192×8 = 512 MiB — larger than the whole
 * pool budget. Pushing it through the pool means every `release` trips
 * `evictOldest`, which destroys that block AND evicts the small live buckets
 * (pool eviction churn). So such a transient must NOT enter the pool
 * at all: it is either engine-owned and reused in place (render path, mechanism
 * B) or created exact-size and destroyed after the frame (export path).
 *
 * The test is on the POT-SNAPPED extent, not the raw one: a transient whose
 * snapped size stays ≤ the ladder ceiling is exactly what the pool buckets were
 * modelled for (small annotations, small strokes, small canvases) and stays pooled.
 *
 * PURE — no device, no GPU handles — so the routing rule has a golden test
 * (`tests/.../oversizedTransient.test.ts`) independent of any live compositor.
 *
 * @module core/engine/gpu/resources/oversizedTransient
 */

import { snapToPowerOfTwo } from './TexturePool';

/**
 * The top of the `TexturePool` POT bucket ladder:
 * 256/512/1024/2048/4096. A transient whose POT-snapped extent EXCEEDS this is
 * "out-of-model" for the pool and must bypass it.
 */
export const POOL_BUCKET_CEILING = 4096;

/**
 * True when a transient of `width × height` would snap to a POT bucket larger
 * than the pool ladder's ceiling on EITHER axis — i.e. it must bypass the POT
 * pool (engine-owned reuse on the render path, one-shot destroy on export).
 *
 * Below the ceiling → pooled as before (this is the common case: small layers,
 * small canvases, tool transients on a modest artboard).
 */
export function isOversizedTransient(width: number, height: number): boolean {
  return (
    snapToPowerOfTwo(width) > POOL_BUCKET_CEILING ||
    snapToPowerOfTwo(height) > POOL_BUCKET_CEILING
  );
}

/**
 * True when a layer's transient spans the WHOLE document canvas at LOGICAL
 * size (layer box ≥ frame box on both axes, scale-independent — the caller's
 * `reqW/reqH` may additionally be enlarged by export superscale or the
 * interactive density band, which must NOT influence this judgement).
 *
 * WHY: a canvas-spanning transient POT-snaps to the very top of the pool
 * ladder — on a 3000×4000 canvas exactly 4096² — which is the pool's LARGEST
 * block: 128 MiB (rgba16float) or 256 MiB (rgba32float, equal to the pool's
 * whole idle budget). Every frame it spends in the pool, its `loadOp: 'clear'`
 * rewrite floods ~25–40% more texels than the content needs, and at the 32-bit
 * format the block sits EXACTLY at `maxFreeBytes`, so one more large transient
 * flowing in evicts it → next-frame `createTexture` churn (the allocation
 * thrash the pool was built to prevent, resurrected at the budget edge).
 *
 * Judged on LOGICAL sizes only. The intended (sole) caller routes the
 * LIVE-EDITED layer's transient — whose box is held CANVAS-SIZED for the
 * whole gesture precisely so its resident slot shape stays stable — to the
 * engine's exact-size resident cache instead of the pool. Committed layers
 * (snug bounding boxes) deliberately stay pooled: N committed spanning layers
 * would otherwise pin N near-canvas resident slots that are re-acquired every
 * recomposite frame and never idle out. Because committed snug boxes can still
 * span the canvas, the size test alone is NOT a router — the caller must
 * additionally match the actively live-edited layer id.
 */
export function isCanvasSpanningTransient(
  layerW: number,
  layerH: number,
  frameW: number,
  frameH: number,
): boolean {
  return layerW >= frameW && layerH >= frameH;
}
