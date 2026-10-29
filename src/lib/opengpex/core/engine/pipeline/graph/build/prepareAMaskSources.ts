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
 * prepareAMaskSources.ts — GPU build step for the ADJUSTMENT-MASK grade
 * chain's coverage: every confined stage (`AdjustStageDesc.coverage`) of every
 * scene layer is baked over the layer's UNION window into the shared
 * frozen-selection cache ( `prepareConfinementSources.ts`, `adjust:` namespace)
 * and gathered into ONE `texture_2d_array` per layer (array layer i = the
 * i-th confined stage in chain order — the same numbering `packAdjustChain`
 * assigns). `texture_2d_array` layers share one size, which is why the whole
 * layer bakes over a single union window rather than per-stage boxes.
 *
 * Rendered BEFORE the filtered-source preparation: the AdjustPrePass bake
 * samples these textures. Layers without a confined stage are absent from the
 * output map — the chain group then binds the default white array and every
 * stage grades the whole layer.
 *
 * @module core/gpu/graph/build/prepareAMaskSources
 */

import type { CompiledScene } from '../SceneCompiler';
import type { BuildContext } from './types';
import { vectorTransientSize } from '../support/vectorTransient';
import { vmaskBakeTransform } from './prepareVmaskSources';
import {
  CONFINEMENT_SOURCE_ADJUST,
  confinementContentToken,
  prepareFrozenSelectionBake,
  sweepFrozenSelectionNamespace,
} from './prepareConfinementSources';
import type { AdjustStageDesc, VectorSubMask } from '../../scene/Scene';
import type { AdjustCoverageBinding } from '../support/adjustBindGroup';
import { GPUTextureUsage } from '@opengpex/editor/core/engine/gpu/constants';

/**
 * One layer's gathered adjust coverage: the array texture (one array layer
 * per confined stage, chain order) + the union window it was baked over.
 */
interface AdjustCoverageEntry {
  readonly key: string;
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly window: readonly [number, number, number, number];
}

/**
 * Per-layer coverage ARRAYS. The per-stage bakes live in the shared
 * frozen-selection cache (under the `adjust:` namespace, keyed by layer +
 * stage index); this cache holds the gathered array each compositing pass
 * binds. An entry is rebuilt (array re-allocated, bakes re-copied) only when
 * its key — every stage's geometry token, feather, AA flag and the bake
 * dimensions — changes.
 */
const adjustCoverageArrays = new Map<string, AdjustCoverageEntry>();

/**
 * Union bake window of all confined stages (layer-local px, clamped to the
 * layer): the rings' bounding box expanded by the largest feather ramp plus
 * an AA margin. Falls back to the full layer when no ring has area.
 * `texture_2d_array` layers share one size, hence ONE window for the layer.
 */
export function resolveAdjustCoverageWindow(
  stages: readonly AdjustStageDesc[],
  layerWidth: number,
  layerHeight: number,
): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } {
  const full = { x: 0, y: 0, w: layerWidth, h: layerHeight };
  let margin = 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let anyRing = false;
  for (const st of stages) {
    if (!st.coverage) continue;
    margin = Math.max(margin, Math.ceil(st.coverage.featherPx * 3) + 2);
    for (const ring of st.coverage.rings) {
      if (ring.length < 3) continue;
      for (const p of ring) {
        anyRing = true;
        x0 = Math.min(x0, p[0]);
        y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]);
        y1 = Math.max(y1, p[1]);
      }
    }
  }
  if (!anyRing) return full;
  const x = Math.max(0, Math.floor(x0 - margin));
  const y = Math.max(0, Math.floor(y0 - margin));
  const w = Math.min(layerWidth, Math.ceil(x1 + margin)) - x;
  const h = Math.min(layerHeight, Math.ceil(y1 + margin)) - y;
  if (w <= 0 || h <= 0) return full;
  return { x, y, w, h };
}

/**
 * Bake the grade-chain COVERAGE for every scene layer with at least one
 * confined stage into `out` keyed by layer id. The sweep touches only the
 * `adjust:` namespace — stroke snapshots in the shared cache are never
 * evicted here.
 *
 * @param exportScale physical-texels-per-logical-px (same semantics as the vmask bake).
 */
export function prepareAdjustCoverageSources(
  encoder: GPUCommandEncoder,
  compiled: CompiledScene,
  ctx: BuildContext,
  out: Map<string, AdjustCoverageBinding>,
  exportScale: readonly [number, number],
): void {
  const seen = new Set<string>();
  const seenLayers = new Set<string>();
  for (const layer of compiled.scene.layers) {
    const stages = layer.adjustStages;
    if (!stages) continue;
    const covered = stages.filter((st) => st.coverage && st.coverage.rings.length > 0);
    if (covered.length === 0) continue;

    const logicalW = Math.max(1, layer.width ?? 1);
    const logicalH = Math.max(1, layer.height ?? 1);
    const window = resolveAdjustCoverageWindow(covered, logicalW, logicalH);
    const [maskW, maskH] = vectorTransientSize(
      window.w, window.h, exportScale,
      ctx.device.limits.maxTextureDimension2D,
    );
    const t = vmaskBakeTransform(window, window.w, window.h, maskW, maskH);

    const bakes: GPUTexture[] = [];
    const keyParts: string[] = [`${maskW}x${maskH}@${window.x},${window.y}`];
    covered.forEach((st, i) => {
      const cov = st.coverage!;
      const key = `${CONFINEMENT_SOURCE_ADJUST}${layer.id}:${i}`;
      const subMasks: VectorSubMask[] = [
        { rings: cov.rings, featherPx: cov.featherPx, inverted: false, antiAliased: cov.antiAliased, distBiasPx: 0 },
      ];
      bakes.push(prepareFrozenSelectionBake(encoder, ctx, key, subMasks, maskW, maskH, t));
      seen.add(key);
      keyParts.push(`${confinementContentToken(cov.rings)}:${cov.featherPx}:${cov.antiAliased ? 1 : 0}`);
    });

    const key = keyParts.join('|');
    let entry = adjustCoverageArrays.get(layer.id);
    if (!entry || entry.key !== key) {
      entry?.texture.destroy();
      const texture = ctx.device.createTexture({
        size: [maskW, maskH, bakes.length],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        label: `Adjust Coverage Array (${layer.id})`,
      });
      bakes.forEach((bake, i) => {
        encoder.copyTextureToTexture(
          { texture: bake },
          { texture, origin: [0, 0, i] },
          [maskW, maskH, 1],
        );
      });
      entry = {
        key,
        texture,
        view: texture.createView({ dimension: '2d-array', label: `Adjust Coverage Array View (${layer.id})` }),
        window: [window.x / logicalW, window.y / logicalH, window.w / logicalW, window.h / logicalH],
      };
      adjustCoverageArrays.set(layer.id, entry);
    }
    out.set(layer.id, { view: entry.view, window: entry.window });
    seenLayers.add(layer.id);
  }
  sweepFrozenSelectionNamespace(seen, CONFINEMENT_SOURCE_ADJUST);
  for (const [id, entry] of adjustCoverageArrays) {
    if (!seenLayers.has(id)) {
      entry.texture.destroy();
      adjustCoverageArrays.delete(id);
    }
  }
}

/** Teardown seam — destroy the gathered arrays (per-stage bakes live in the shared cache). */
export function clearAMaskCoverageArrays(): void {
  for (const entry of adjustCoverageArrays.values()) entry.texture.destroy();
  adjustCoverageArrays.clear();
}
