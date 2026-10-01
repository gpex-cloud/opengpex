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
 * StrokeRenderer.ts — Vector render strategy: compute-extruded stroke ribbon
 * (Layer B). The vector brush (see
 * brush stroke logic): a compute prepass
 * extrudes a ribbon mesh from the stroke trajectory, then a paint draw rasterizes it
 * with soft-edge coverage into the same offscreen transient the spine already owns —
 * a render TECHNIQUE parallel to `SdfRenderer`, not merged into its shader.
 *
 * OUTPUT CONTRACT (architecture B, identical to `SdfRenderer`): the target holds
 * STRAIGHT-alpha, WORKING-gamut (Display-P3) linear-light pixels. The caller clears the
 * target first; this pass writes with REPLACE blend and applies neither `layer.opacity`
 * nor mask — those are the downstream `drawLayer`'s job, exactly as for any raster source.
 *
 * ── SAME-SOURCE SYNC CONTRACT (load-bearing) ──
 * `encodePrepass` and `render` run back-to-back for ONE source inside
 * `prepareVectorSources`'s single-threaded, synchronous loop (encodePrepass, then
 * beginRenderPass, then render, then end — before the next layer is touched). So the
 * `pending` instance field safely carries the extruded verts slot from the compute
 * prepass to the paint draw (the same rationale as `SdfRenderer`'s module-level scratch).
 * Both stages record onto the SAME command encoder, so at submit the GPU sees the
 * compute WRITE of `verts` before the render READ of it — the ordering is guaranteed.
 *
 * @module core/gpu/graph/build/vectorRenderers/StrokeRenderer
 */

import { GPUBufferUsage } from '@opengpex/editor/core/engine/gpu/constants';
import { BufferRing, type BufferSlot } from '@opengpex/editor/core/engine/gpu/resources/BufferRing';
import {
  STROKE_UNIFORM_BUFFER_SIZE,
  STROKE_VERTS_PER_SEGMENT,
  STROKE_VERTEX_STRIDE,
  STROKE_EXTRUDE_WORKGROUP_SIZE,
} from '@opengpex/editor/core/engine/gpu/shaders/stroke';
import type { StrokeParams } from '../../../scene/Scene';
import type { VectorRenderer, VectorRenderContext, VectorRenderArgs } from './VectorRenderer';

/**
 * Capacity of each private storage ring (8 MiB). `pts` and `verts` MUST live in
 * SEPARATE GPUBuffers: WebGPU's compute-pass synchronization scope is per-BUFFER, so
 * the same buffer used as read-only storage (pts) AND read-write storage (verts) in one
 * pass — even in non-overlapping ranges — is a usage conflict. Two rings sidestep it.
 * `vertsRing` is the binding constraint: each segment costs
 * `STROKE_VERTS_PER_SEGMENT × STROKE_VERTEX_STRIDE` = 192 bytes, so 8 MiB holds at most
 * ~43,690 segments (~43,691 points) before `BufferRing.allocate` returns an
 * out-of-bounds slot and WebGPU raises a validation error instead of degrading
 * gracefully. `BrushOverlay`'s `MAX_STROKE_POINTS` (40,000, see
 * `plugins/base/overlays/BrushOverlay/protocols.ts`) hard-clamps a single drag
 * safely under this ceiling. Neither ring is reset here — the cursor advances and
 * wraps; each `encodePrepass` re-uploads fresh.
 */
const STROKE_RING_CAPACITY = 8 * 1024 * 1024;

/**
 * Reusable scratch for packing the paint uniform block (32 bytes). MODULE-LEVEL and
 * mutable, safe under the strictly single-threaded synchronous render path (mirrors
 * `SdfRenderer`'s `uniformData` note — convert to per-call if ever made async).
 */
const uniformData = new Float32Array(STROKE_UNIFORM_BUFFER_SIZE / 4);

export class StrokeRenderer implements VectorRenderer {
  /** Stroke writes pure coverage/colour; it never reads a composited backdrop. */
  readonly needsBackdrop = false;

  /** Lazily-built storage rings for pts / verts (SEPARATE buffers — see capacity note). */
  private ptsRing: BufferRing | null = null;
  private vertsRing: BufferRing | null = null;
  private ringDevice: GPUDevice | null = null;

  /** Verts slot + draw count handed from `encodePrepass` to `render` for one source. */
  private pending: { verts: BufferSlot; vertexCount: number } | null = null;

  /** Lazily create (or rebuild on device change) the two storage rings. */
  private ensureRings(device: GPUDevice): { pts: BufferRing; verts: BufferRing } {
    if (this.ptsRing && this.vertsRing && this.ringDevice === device) {
      return { pts: this.ptsRing, verts: this.vertsRing };
    }
    this.ptsRing?.destroy();
    this.vertsRing?.destroy();
    // pts: read-only storage the compute reads; uploaded via writeSlot (COPY_DST).
    this.ptsRing = new BufferRing(
      device,
      STROKE_RING_CAPACITY,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      'Stroke Pts Ring',
    );
    // verts: read-write storage the compute writes, then bound as the paint vertex buffer.
    this.vertsRing = new BufferRing(
      device,
      STROKE_RING_CAPACITY,
      GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
      'Stroke Verts Ring',
    );
    this.ringDevice = device;
    return { pts: this.ptsRing, verts: this.vertsRing };
  }

  /**
   * Compute prepass — upload the trajectory, allocate the ribbon verts, and run
   * `cs_extrude` (one invocation per segment). Recorded onto the surrounding encoder
   * BEFORE the render pass opens (WebGPU forbids a compute pass inside a render pass).
   */
  encodePrepass(encoder: GPUCommandEncoder, ctx: VectorRenderContext, args: VectorRenderArgs): void {
    if (args.params.renderer !== 'stroke') {
      throw new Error(`StrokeRenderer received non-stroke params: ${args.params.renderer}`);
    }
    const p: StrokeParams = args.params.stroke;

    // A ribbon needs ≥2 points (≥1 segment); anything less extrudes nothing.
    const segments = p.pointCount - 1;
    if (segments < 1) {
      this.pending = null;
      return;
    }

    const { pts: ptsRing, verts: vertsRing } = this.ensureRings(ctx.device);
    const ptsSlot = ptsRing.writeSlot(p.points);
    const vertsSlot = vertsRing.allocate(segments * STROKE_VERTS_PER_SEGMENT * STROKE_VERTEX_STRIDE);

    const bindGroup = ctx.device.createBindGroup({
      layout: ctx.pipelineCache.getStrokeExtrudeBindGroupLayout(),
      label: 'Stroke Extrude BindGroup',
      entries: [
        { binding: 0, resource: { buffer: ptsSlot.buffer, offset: ptsSlot.offset, size: ptsSlot.size } },
        { binding: 1, resource: { buffer: vertsSlot.buffer, offset: vertsSlot.offset, size: vertsSlot.size } },
      ],
    });

    const pass = encoder.beginComputePass({
      label: 'Stroke Extrude Pass',
      timestampWrites: ctx.timestamp?.('stroke-extrude'),
    });
    pass.setPipeline(ctx.pipelineCache.getStrokeExtrudePipeline());
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(segments / STROKE_EXTRUDE_WORKGROUP_SIZE));
    pass.end();

    this.pending = { verts: vertsSlot, vertexCount: segments * STROKE_VERTS_PER_SEGMENT };
  }

  /**
   * Paint draw — bind the ribbon vertex buffer produced by `encodePrepass` and
   * rasterize soft-edge coverage into the ACTIVE render pass (colour attachment = the
   * source's already-cleared transient). The caller owns the render pass lifetime.
   */
  render(pass: GPURenderPassEncoder, ctx: VectorRenderContext, args: VectorRenderArgs): void {
    if (args.params.renderer !== 'stroke') {
      throw new Error(`StrokeRenderer received non-stroke params: ${args.params.renderer}`);
    }
    // A degenerate stroke (<2 points) extruded nothing — draw nothing.
    if (!this.pending) return;

    const { device, pipelineCache, bufferRing, targetFormat } = ctx;
    const p: StrokeParams = args.params.stroke;

    // offset 0 (16B) colour — working-gamut linear, straight alpha
    uniformData[0] = p.color[0];
    uniformData[1] = p.color[1];
    uniformData[2] = p.color[2];
    uniformData[3] = p.color[3];
    // offset 16 (8B) target_size — bounding logical px for the NDC map
    uniformData[4] = p.width;
    uniformData[5] = p.height;
    // offset 24 (4B) size, offset 28 (4B) hardness
    uniformData[6] = p.size;
    uniformData[7] = p.hardness;

    const slot = bufferRing.writeSlot(uniformData);

    const bindGroup = device.createBindGroup({
      layout: pipelineCache.getStrokeRenderBindGroupLayout(),
      label: 'Stroke Render BindGroup',
      entries: [
        {
          binding: 0,
          resource: { buffer: bufferRing.getBuffer(), offset: 0, size: STROKE_UNIFORM_BUFFER_SIZE },
        },
      ],
    });

    pass.setPipeline(pipelineCache.getStrokePipeline(targetFormat));
    pass.setVertexBuffer(0, this.pending.verts.buffer, this.pending.verts.offset, this.pending.verts.size);
    pass.setBindGroup(0, bindGroup, [slot.offset]);
    pass.draw(this.pending.vertexCount);

    this.pending = null;
  }
}

/** Engine built-in singleton — the logic-brush slot. */
export const strokeRenderer = new StrokeRenderer();
