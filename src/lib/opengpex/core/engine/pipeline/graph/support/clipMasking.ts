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
 * clipMasking.ts — Photoshop-style clipping-mask resolution (the `LayerNode.clipMasked`
 * chain) and the per-draw sampling parameters the composite passes need to
 * multiply a clipped node's foreground alpha by its clip base's alpha.
 *
 * SEMANTICS: a layer with `clipMasked: true` is masked by the nearest PRECEDING
 * layer that is NOT itself clipped (the clip base). Consecutive clipped layers
 * all mask against the same base. Every draw of a clipped node — its body step
 * AND every split external-effect step (which `splitExternalEffectLayer` copies
 * `clip` onto) — must multiply its alpha by the SAME base coverage, so the
 * member content and its shadow/glow/stroke stay clipped on one identical
 * silhouette with no seam.
 *
 * SAMPLING CONTRACT: the composite shaders receive two affine rows mapping the
 * framebuffer pixel (target px, the `@builtin(position)` of the full-frame or
 * layer quad) into the base's LOCAL UNIT quad (0..1 inside the base content
 * rect, outside otherwise), plus the base's physical UV rect. Coverage =
 * inside-gate × texture alpha (a declarative-solid base binds the 1×1 white
 * formality, so the texture alpha is 1 and the inside-gate alone forms the
 * rect coverage — identical to how the base itself would draw).
 *
 * The affine derivation mirrors `packLayerUniforms` (doc-space forward affine
 * folded with the export viewport's source→target scale) — the SAME mapping
 * `blend.wgsl` inverts for the foreground, so a clipped node and its base
 * cannot disagree about where "frame pixel" is.
 *
 * @module core/engine/pipeline/graph/support/clipMasking
 */

import type { LayerNode } from '../../scene/Scene';
import type { LayerDrawGeometry } from '../build/support/resolveDrawSource';

/**
 * The doc→frame mapping the active export/interaction viewport induces:
 * doc px = (srcX + frame px · sx, srcY + frame px · sy). Omitted → identity
 * (frame px == doc px, the no-viewport composite).
 */
export interface DocToFrameMapping {
  readonly srcX: number;
  readonly srcY: number;
  readonly sx: number;
  readonly sy: number;
}

/** Id suffix `splitExternalEffectLayer` appends to synthetic effect nodes. */
const EFFECT_ID_MARKER = '::eff:';

/**
 * Resolve the clip base of ONE scene node: the nearest PRECEDING layer in
 * z-order that does not itself carry `clipMasked`. Synthetic effect nodes
 * (`${owner}::eff:${i}`) resolve against their owner's position. Returns
 * `undefined` when no base exists (a clipped node leading the scene — such a
 * member has nothing to clip to and draws nothing).
 */
export function resolveClipBaseLayer(
  layers: readonly LayerNode[],
  node: LayerNode,
): LayerNode | undefined {
  // Synthetic effect steps are not scene members: map back to the owner layer
  // whose `effects` stage produced them. An unclipped node has no clip base
  // by definition.
  if (!node.clipMasked) return undefined;
  let anchorIndex = -1;
  for (let i = 0; i < layers.length; i++) {
    const candidate = layers[i];
    if (candidate === node || node.id === candidate.id) {
      anchorIndex = i;
      break;
    }
    if (node.id.startsWith(`${candidate.id}${EFFECT_ID_MARKER}`)) {
      anchorIndex = i;
      break;
    }
  }
  if (anchorIndex === -1) return undefined;
  for (let i = anchorIndex - 1; i >= 0; i--) {
    if (!layers[i].clipMasked) return layers[i];
  }
  return undefined;
}

/**
 * Everything the composite passes need to gate one clipped draw against its
 * base. `frameToLocal` packs the inverse of the base placement (frame px →
 * base-local unit quad) as the two affine rows `(ia, ib, itx)` / `(ic, id,
 * ity)`; `uvRect` is the base's physical UV rect (the same POT-bucket values
 * the base's own draw samples through).
 */
export interface ClipBaseSampling {
  readonly frameToLocal: readonly [
    number, number, number,
    number, number, number,
  ];
  readonly uvRect: readonly [number, number, number, number];
}

/**
 * Compute the clip-base sampling parameters for one draw. `docToFrame` is the
 * active viewport mapping (see {@link DocToFrameMapping}) — derive it with the
 * SAME expression the draw pass uses for its foreground inverse
 * (`srcW / targetW` etc.), so frame-pixel semantics agree bit-for-bit between
 * the gate and the foreground. Geometry comes from
 * `resolveLayerDrawGeometry(baseLayer, baseTexture, baseDrawParams)` — the
 * identical call the base's own draw makes, so the coverage silhouette is the
 * base's drawn extent, not a re-derived approximation.
 */
export function computeClipBaseSampling(
  baseGeometry: LayerDrawGeometry,
  baseTransform: LayerNode['transform'],
  docToFrame?: DocToFrameMapping,
): ClipBaseSampling {
  const t = baseTransform;
  const ox = baseGeometry.localOffset[0];
  const oy = baseGeometry.localOffset[1];
  // Forward affine (doc px = M · local unit) — identical linear part to
  // packLayerUniforms' placement minus the NDC scale.
  const aPrime = t.a * baseGeometry.contentWidth;
  const bPrime = t.b * baseGeometry.contentWidth;
  const cPrime = t.c * baseGeometry.contentHeight;
  const dPrime = t.d * baseGeometry.contentHeight;
  const txp = t.a * ox + t.c * oy + t.tx;
  const typ = t.b * ox + t.d * oy + t.ty;

  const srcX = docToFrame?.srcX ?? 0;
  const srcY = docToFrame?.srcY ?? 0;
  const sx = docToFrame?.sx ?? 1;
  const sy = docToFrame?.sy ?? 1;

  // Invert the forward affine (doc px → local unit)…
  const det = aPrime * dPrime - cPrime * bPrime;
  if (Math.abs(det) <= 1e-12) {
    // Degenerate base placement (zero area): map every frame pixel far
    // outside the unit quad so coverage is 0 everywhere — a zero-area base
    // clips its members to nothing.
    return {
      frameToLocal: [0, 0, -1, 0, 0, -1],
      uvRect: [0, 0, 1, 1],
    };
  }
  const inv = 1 / det;
  const ia = dPrime * inv;
  const ib = -bPrime * inv;
  const ic = -cPrime * inv;
  const id = aPrime * inv;
  const itx = -(ia * txp + ic * typ);
  const ity = -(ib * txp + id * typ);
  // …then fold the doc→frame mapping in front: local = inv · (src + frame·s).
  return {
    frameToLocal: [
      ia * sx,
      ib * sx,
      ia * srcX + ic * srcY + itx,
      ic * sy,
      id * sy,
      ib * srcX + id * srcY + ity,
    ],
    uvRect: baseGeometry.physicalUvRect,
  };
}
