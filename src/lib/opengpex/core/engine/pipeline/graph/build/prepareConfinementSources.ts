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
 * prepareConfinementSources.ts — GPU compute fill-pass orchestration for
 * FROZEN-SELECTION coverage: selection snapshots frozen onto consumers as
 * plain even-odd coverage textures, baked by the same multiply fill pipeline
 * as polygon vmasks (`prepareVmaskSources.ts` owns that pipeline and the
 * VmaskCache class; this module owns the CONFINEMENT cache and its namespaced
 * keys).
 *
 * Two consumers share ONE operation and ONE cache:
 *   • vector-brush strokes (`StrokeData.confinement`, `stroke:` namespace,
 *     baked from prepareVectorSources) — coverage multiplies the stroke
 *     transient's alpha so a stroke paints only inside its snapshot;
 *   • adjustment masks (`AdjustStageDesc.coverage`, `adjust:` namespace,
 *     baked from `prepareAMaskSources.ts`, which owns its consumer-specific
 *     array gathering on top of the shared bake) — the grading shaders blend
 *     `mix(original, graded, coverage)` so the grade only applies inside the
 *     snapshot and alpha is never clipped.
 *
 * The cache key is `${prefix}${layerId}` — position-free (rings are layer-local
 * crop-space px, so a pan/move never re-bakes) and collision-free between the
 * two consumers at the same layer id. Each consumer sweeps only its own prefix
 * through {@link sweepFrozenSelectionNamespace}.
 *
 * @module core/gpu/graph/build/prepareConfinementSources
 */

import type { BuildContext } from './types';
import { vectorTransientSize } from '../support/vectorTransient';
import { VmaskCache, vmaskBakeTransform } from './prepareVmaskSources';
import type { VectorSubMask } from '../../scene/Scene';

/**
 * SHARED cache for FROZEN-SELECTION coverage — the frozen selection snapshots
 * of BOTH consumers (vector-brush strokes and local adjustments). Deliberately
 * NOT the vmask cache: the selection-confinement semantics multiply through the
 * same fill compute but never share cached storage with hole masks. Isolation
 * BETWEEN the two consumers lives in the KEY NAMESPACE, not in separate cache
 * instances: the caller prefixes the layer id (`stroke:` / `adjust:`), so the
 * same layer can carry both snapshots without ever colliding or evicting each
 * other, and each consumer sweeps only its own prefix.
 */
const confinementCache = new VmaskCache();

/**
 * Namespace prefixes for the shared frozen-selection coverage cache. The key
 * of a cache entry is `${prefix}${layerId}` — a layer's stroke snapshot and
 * adjustment snapshot are distinct entries even at the same layer id.
 */
export const CONFINEMENT_SOURCE_STROKE = 'stroke:';
export const CONFINEMENT_SOURCE_ADJUST = 'adjust:';

/**
 * Bake (or reuse) the FROZEN-SELECTION coverage for one layer and record the
 * fill dispatch onto `encoder`. One operation shared by both consumers:
 * wrap a snapshot's rings as one plain even-odd sub-mask (no feather, never
 * inverted) and bake it into the shared cache over the layer's full logical
 * extent. The rings are LAYER-LOCAL crop-space pixels, so the cache key is
 * position-free and moving the layer never re-bakes; the sampling side reads
 * the texture 1:1 via normalized uv.
 *
 * @param key          cache entry key — the caller-namespaced layer id, built
 *                     from `CONFINEMENT_SOURCE_STROKE` / `CONFINEMENT_SOURCE_ADJUST`
 *                     + the layer id, so the two consumers never share entries.
 * @param antiAliased  the selection's own edge flag (stroke snapshots carry one;
 *                     adjustment snapshots have no edge flag and pass `true`).
 * @param exportScale  physical-texels-per-logical-px (same semantics as the vmask bake).
 */
export function prepareConfinementCoverage(
  encoder: GPUCommandEncoder,
  ctx: BuildContext,
  key: string,
  rings: readonly (readonly (readonly [number, number])[])[],
  antiAliased: boolean,
  logicalW: number,
  logicalH: number,
  exportScale: readonly [number, number],
): GPUTexture {
  const subMasks: VectorSubMask[] = [
    // A frozen selection snapshot is a plain even-odd region: no feather, never
    // inverted; AA per the snapshot's own edge flag.
    { rings, featherPx: 0, inverted: false, antiAliased, distBiasPx: 0 },
  ];
  const [maskW, maskH] = vectorTransientSize(
    Math.max(1, logicalW), Math.max(1, logicalH), exportScale,
    ctx.device.limits.maxTextureDimension2D,
  );
  const t = vmaskBakeTransform(undefined, Math.max(1, logicalW), Math.max(1, logicalH), maskW, maskH);
  confinementCache.setPxScale(t.pxScaleX, t.pxScaleY);
  confinementCache.setOrigin(t.originX, t.originY);
  return confinementCache.prepare(encoder, ctx, key, subMasks, maskW, maskH).texture;
}

/**
 * Bake (or reuse) one namespaced entry of the shared cache with an explicit
 * bake transform. The general shape behind {@link prepareConfinementCoverage}:
 * consumers that need their own windowing / per-entry sub-mask composition
 * (e.g. `prepareAMaskSources.ts`) drive the cache directly through this seam
 * instead of the single-snapshot convenience wrapper.
 */
export function prepareFrozenSelectionBake(
  encoder: GPUCommandEncoder,
  ctx: BuildContext,
  key: string,
  subMasks: readonly VectorSubMask[],
  maskW: number,
  maskH: number,
  transform: { readonly pxScaleX: number; readonly pxScaleY: number; readonly originX: number; readonly originY: number },
): GPUTexture {
  confinementCache.setPxScale(transform.pxScaleX, transform.pxScaleY);
  confinementCache.setOrigin(transform.originX, transform.originY);
  return confinementCache.prepare(encoder, ctx, key, subMasks, maskW, maskH).texture;
}

/**
 * Sweep ONE namespace of the shared coverage cache against the keys seen this
 * frame. Stroke keys embed a per-stroke content token (index + rings digest),
 * so undo/redo churn would otherwise accumulate stale bakes forever — the
 * adjust namespace keys by layer + stage index and sweeps its own prefix in
 * `prepareAMaskSources.ts`.
 */
export function sweepFrozenSelectionNamespace(seen: Set<string>, prefix: string): void {
  confinementCache.sweep(seen, prefix);
}

/** Teardown seam for the frozen-selection coverage cache — wire alongside clearVmaskCache(). */
export function clearConfinementCoverageCache(): void {
  confinementCache.clear();
}

/**
 * Compact content token for one stroke's frozen selection rings — a stable
 * digest over the ring geometry (count, per-ring length, first/last point and
 * a stride-sampled FNV-1a over coordinates). Selection snapshots are frozen at
 * stroke creation and never mutate, so the token's only job is to distinguish
 * DIFFERENT snapshots that land at the same cache-key slot after undo/redo
 * re-arranged the stroke array; exact collision-freedom is not required (the
 * rings are re-baked on any token change, never on a token match with
 * different content — impossible under the immutability contract).
 */
export function confinementContentToken(
  rings: readonly (readonly (readonly [number, number])[])[],
): string {
  let hash = 0x811c9dc5;
  const step = (v: number) => {
    hash ^= v & 0xffff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  step(rings.length);
  for (const ring of rings) {
    step(ring.length);
    const stride = Math.max(1, Math.floor(ring.length / 8));
    for (let i = 0; i < ring.length; i += stride) {
      step(Math.round(ring[i][0] * 4));
      step(Math.round(ring[i][1] * 4));
    }
    if (ring.length > 0) {
      const last = ring[ring.length - 1];
      step(Math.round(last[0] * 4));
      step(Math.round(last[1] * 4));
    }
  }
  return hash.toString(36);
}
