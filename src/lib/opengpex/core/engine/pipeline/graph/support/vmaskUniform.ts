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
 * vmaskUniform.ts — pack a `VectorMaskDesc` into the `vmask_flags`/`vmask_rect`/
 * `vmask_feather` uniform fields shared by `CompositePass` and `BlendPass`.
 *
 * ONE place turns the declarative mask descriptor into the numeric uniform triple,
 * so the two passes stay byte-for-byte aligned (they already share
 * `packLayerUniforms`). Pure — no device/GPU state — so it is unit-testable against
 * the bit layout and dispatch truth table.
 *
 * @module core/gpu/graph/support/vmaskUniform
 */

import type { VectorMaskDesc } from '../../scene/Scene';
import {
  VMASK_FLAG_HAS_ANALYTIC,
  VMASK_FLAG_HAS_TEX,
  VMASK_FLAG_INVERTED,
  VMASK_FLAG_HARD,
  VMASK_SHAPE_SHIFT,
  VMASK_SHAPE_RECT,
  VMASK_SHAPE_ELLIPSE,
} from '@opengpex/editor/core/engine/gpu/shaders/layer';

export interface VmaskUniformFields {
  /** `vmask_flags` (offset 76). 0 ⇒ shader skips the vmask branch entirely. */
  readonly flags: number;
  /** `vmask_rect` (cx, cy, halfW, halfH) in layer-local pixels (analytic only). */
  readonly rect: readonly [number, number, number, number];
  /** `vmask_feather` (featherPx, maskPxW, maskPxH, _reserved). */
  readonly feather: readonly [number, number, number, number];
}

const NONE: VmaskUniformFields = { flags: 0, rect: [0, 0, 0, 0], feather: [0, 0, 0, 0] };

/**
 * @param vmask            the layer's vector mask descriptor (may be undefined)
 * @param contentWidth     layer content width in logical px (maps normalized→px)
 * @param contentHeight    layer content height in logical px
 * @param hasBakedTexture  whether the polygon fill-pass produced a texture this frame
 */
export function resolveVmaskUniform(
  vmask: VectorMaskDesc | undefined,
  contentWidth: number,
  contentHeight: number,
  hasBakedTexture: boolean,
): VmaskUniformFields {
  if (!vmask) return NONE;

  if (vmask.kind === 'analytic') {
    let flags = VMASK_FLAG_HAS_ANALYTIC;
    const shapeId = vmask.shape === 'ellipse' ? VMASK_SHAPE_ELLIPSE : VMASK_SHAPE_RECT;
    flags |= shapeId << VMASK_SHAPE_SHIFT;
    if (vmask.inverted) flags |= VMASK_FLAG_INVERTED;
    if (vmask.hard) flags |= VMASK_FLAG_HARD;
    const [cx, cy, halfW, halfH] = vmask.rect;
    return {
      flags,
      // normalized [0..1] (fraction of width/height) → layer-local pixel space.
      rect: [cx * contentWidth, cy * contentHeight, halfW * contentWidth, halfH * contentHeight],
      feather: [vmask.featherPx, contentWidth, contentHeight, 0],
    };
  }

  // Polygon: valid only when the fill-pass baked a texture this frame. If it did
  // not (defensive — should never happen), degrade to no-vmask rather than sample
  // the 1×1 default-white view (which would multiply alpha by 1, i.e. no mask).
  if (!hasBakedTexture) return NONE;
  // invert/hard are ALREADY baked into the texture — no INVERTED/HARD bit.
  return { flags: VMASK_FLAG_HAS_TEX, rect: [0, 0, 0, 0], feather: [0, 0, 0, 0] };
}
