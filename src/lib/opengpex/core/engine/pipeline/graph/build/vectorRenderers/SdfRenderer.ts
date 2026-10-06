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
 * SdfRenderer.ts — Vector render strategy: analytic SDF fragment draw (Layer B).
 * Renders one engine-neutral SDF primitive (rounded_rect / ellipse / arrow) into a
 * transient texture. A zero-texture procedural draw: pack the 80-byte SDF uniform
 * block into the shared BufferRing, bind it alone (no sampler/source/mask), and
 * issue the full-target quad draw.
 *
 * OUTPUT CONTRACT (architecture B): the target holds STRAIGHT-alpha, WORKING-gamut
 * (Display-P3) linear-light pixels. The caller clears the target first; this pass
 * writes with REPLACE blend and applies neither `layer.opacity` nor mask — those
 * are the downstream `drawLayer`'s job, exactly as for any raster source.
 *
 * @module core/gpu/graph/build/vectorRenderers/SdfRenderer
 */

import type { SdfShapeParams, SdfPrimitive } from '../../../scene/Scene';
import { SDF_UNIFORM_BUFFER_SIZE } from '@opengpex/editor/core/engine/gpu/shaders/sdf';
import type { VectorRenderer, VectorRenderContext, VectorRenderArgs } from './VectorRenderer';

/** shape_type wire values — must match `sdf.ts` (0 rounded_rect, 1 ellipse, 2 arrow). */
const SHAPE_TYPE: Record<SdfPrimitive, number> = {
  rounded_rect: 0,
  ellipse: 1,
  arrow: 2,
};

/**
 * Reusable scratch for packing the SDF uniform block (80 bytes). MODULE-LEVEL and
 * mutable, safe under the strictly single-threaded, synchronous render path (mirrors
 * `CompositePass`'s `uniformData` note — convert to per-call if ever made async).
 */
const uniformData = new Float32Array(SDF_UNIFORM_BUFFER_SIZE / 4);
const uniformUintView = new Uint32Array(uniformData.buffer);

export class SdfRenderer implements VectorRenderer {
  /** SDF writes pure coverage/colour; it never reads a composited backdrop. */
  readonly needsBackdrop = false;

  /**
   * Record the SDF draw onto an ACTIVE render pass whose colour attachment is the
   * source's transient (already cleared by the caller). The caller owns the render
   * pass lifetime so this can batch into the surrounding encoder.
   */
  render(
    pass: GPURenderPassEncoder,
    ctx: VectorRenderContext,
    args: VectorRenderArgs,
  ): void {
    if (args.params.renderer !== 'sdf') {
      throw new Error(`SdfRenderer received non-sdf params: ${args.params.renderer}`);
    }
    const { device, pipelineCache, bufferRing, targetFormat } = ctx;
    const m: SdfShapeParams = args.params.sdf;

    // offset 0 (16B)
    uniformData[0] = m.size[0];
    uniformData[1] = m.size[1];
    uniformUintView[2] = SHAPE_TYPE[m.prim];
    uniformUintView[3] = m.hasFill ? 1 : 0;
    // offset 16 (16B)
    uniformData[4] = m.strokeWidth;
    uniformData[5] = m.headScale;
    uniformUintView[6] = m.antiAliased ? 0 : 1; // shader `hard_edge` (0 = AA on)
    uniformData[7] = 0;
    // offset 32 (16B) stroke_color
    uniformData[8] = m.strokeColor[0];
    uniformData[9] = m.strokeColor[1];
    uniformData[10] = m.strokeColor[2];
    uniformData[11] = m.strokeColor[3];
    // offset 48 (16B) fill_color (alpha already × fill.opacity)
    uniformData[12] = m.fillColor[0];
    uniformData[13] = m.fillColor[1];
    uniformData[14] = m.fillColor[2];
    uniformData[15] = m.fillColor[3];
    // offset 64 (16B) shape_params
    uniformData[16] = m.shapeParams[0];
    uniformData[17] = m.shapeParams[1];
    uniformData[18] = m.shapeParams[2];
    uniformData[19] = m.shapeParams[3];

    const slot = bufferRing.writeSlot(uniformData);

    const bindGroup = device.createBindGroup({
      layout: pipelineCache.getSdfBindGroupLayout(),
      label: 'SDF BindGroup',
      entries: [
        {
          binding: 0,
          resource: {
            buffer: bufferRing.getBuffer(),
            offset: 0,
            size: SDF_UNIFORM_BUFFER_SIZE,
          },
        },
      ],
    });

    pass.setPipeline(pipelineCache.getSdfPipeline(targetFormat));
    pass.setVertexBuffer(0, pipelineCache.getQuadVertexBuffer());
    pass.setBindGroup(0, bindGroup, [slot.offset]);
    pass.draw(6);
  }
}

/** Engine built-in singleton — stateless, safe to share. */
export const sdfRenderer = new SdfRenderer();
