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
 * STRAIGHT-alpha, WORKING-gamut (ProPhoto RGB) linear-light pixels. The caller clears the
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
 * Default capacity of each private storage ring (8 MiB). `pts` and `verts` MUST
 * live in SEPARATE GPUBuffers: WebGPU's compute-pass synchronization scope is per-BUFFER,
 * so the same buffer used as read-only storage (pts) AND read-write storage (verts) in one
 * pass — even in non-overlapping ranges — is a usage conflict. Two rings sidestep it.
 * `vertsRing` is the binding constraint: each segment costs
 * `STROKE_VERTS_PER_SEGMENT × STROKE_VERTEX_STRIDE` = 240 bytes, so the default holds
 * ~34,952 segments. `encodePrepass` sums the frame's actual demand first and GROWS the
 * rings before opening the pass (see `ringCapacity` there) — the default only has to
 * cover ordinary strokes, not the worst case. `BrushOverlay`'s `MAX_STROKE_POINTS`
 * (40,000, see `plugins/base/overlays/BrushOverlay/protocols.ts`) bounds a single
 * stroke's packed pts stream (16 B/point ≈ 2.4 MiB at the cap, well inside the pts ring).
 * Neither ring is reset here — the cursor advances and wraps; each `encodePrepass`
 * re-uploads fresh, and the capacity check guarantees a frame never wraps mid-pass.
 */
const STROKE_RING_CAPACITY = 8 * 1024 * 1024;

/**
 * Reusable scratch for packing the paint uniform block (48 bytes). MODULE-LEVEL and
 * mutable, safe under the strictly single-threaded synchronous render path (mirrors
 * `SdfRenderer`'s `uniformData` note — convert to per-call if ever made async).
 */
const uniformData = new Float32Array(STROKE_UNIFORM_BUFFER_SIZE / 4);

/**
 * Uint32 view over `uniformData.buffer` for writing the non-float flag slot
 * (`hard_edge: u32` at byte offset 32 = float index 8). Mirrors `SdfRenderer`'s
 * uint view over its uniform scratch.
 */
const uniformUintView = new Uint32Array(uniformData.buffer);

export class StrokeRenderer implements VectorRenderer {
  /** Stroke writes pure coverage/colour; it never reads a composited backdrop. */
  readonly needsBackdrop = false;

  /** Lazily-built storage rings for pts / verts (SEPARATE buffers — see capacity note). */
  private ptsRing: BufferRing | null = null;
  private vertsRing: BufferRing | null = null;
  private ringDevice: GPUDevice | null = null;
  /**
   * Live ring capacity in bytes. `BufferRing` has no same-frame overflow
   * protection — `allocate` silently wraps to offset 0, and a wrap MID-FRAME
   * hands a later stroke the slot an earlier stroke's bind group already
   * points at (its compute output overwrites the predecessor's vertices while
   * they are still to be drawn). Every allocation of a frame therefore has to
   * fit between the frame's ring start and the capacity. When the summed
   * demand of the frame's strokes exceeds the current capacity the rings are
   * rebuilt larger BEFORE the compute pass opens (safe: nothing from previous
   * frames survives a prepass — pts are re-uploaded and verts re-extruded
   * every frame).
   */
  private ringCapacity = STROKE_RING_CAPACITY;

  /** Per-stroke verts slot + draw count, handed from `encodePrepass` to `render`
   *  for one source (one entry per stroke in the collection, draw order preserved). */
  private pending: { verts: BufferSlot; vertexCount: number }[] = [];

  /** Lazily create (or rebuild on device change or capacity growth) the two storage rings. */
  private ensureRings(device: GPUDevice): { pts: BufferRing; verts: BufferRing } {
    if (
      this.ptsRing &&
      this.vertsRing &&
      this.ringDevice === device &&
      this.ptsRing.capacity === this.ringCapacity
    ) {
      return { pts: this.ptsRing, verts: this.vertsRing };
    }
    this.ptsRing?.destroy();
    this.vertsRing?.destroy();
    // pts: read-only storage the compute reads; uploaded via writeSlot (COPY_DST).
    this.ptsRing = new BufferRing(
      device,
      this.ringCapacity,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      'Stroke Pts Ring',
    );
    // verts: read-write storage the compute writes, then bound as the paint vertex buffer.
    this.vertsRing = new BufferRing(
      device,
      this.ringCapacity,
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
    const strokes: readonly StrokeParams[] = args.params.strokes;
    this.pending = [];

    const extrudable = strokes.filter((p) => p.pointCount - 1 >= 1);
    if (extrudable.length === 0) return;

    // Size the rings for the frame's actual demand before opening the compute
    // pass: both rings must hold every allocation of this frame between the
    // frame's ring start and the capacity, or `allocate` wraps mid-frame and a
    // later stroke's vertices overwrite an earlier stroke's slot. Growth
    // doubles from the default and then follows demand, rounded to whole MiB,
    // clamped to the device's max buffer size. Slot alignment overhead is at
    // most one alignment unit per stroke (256B class), far inside the margin.
    let ptsBytes = 0;
    let vertsBytes = 0;
    for (const p of extrudable) {
      ptsBytes += p.points.byteLength;
      vertsBytes += (p.pointCount - 1) * STROKE_VERTS_PER_SEGMENT * STROKE_VERTEX_STRIDE;
    }
    const frameNeed = Math.max(ptsBytes, vertsBytes);
    if (frameNeed > this.ringCapacity) {
      const maxBuffer = ctx.device.limits.maxBufferSize;
      this.ringCapacity = Math.min(
        maxBuffer,
        Math.max(Math.ceil((frameNeed * 2) / (1024 * 1024)) * (1024 * 1024), STROKE_RING_CAPACITY),
      );
      console.warn(
        `Stroke rings grown to ${this.ringCapacity} bytes for a ${frameNeed}-byte frame`,
      );
    }

    const { pts: ptsRing, verts: vertsRing } = this.ensureRings(ctx.device);

    // ONE compute pass for the whole collection: every stroke's extrude dispatch
    // shares the pipeline; per-stroke bind groups point at that stroke's own
    // pts/verts slots (rings wrap independently, slots never overlap).
    const pass = encoder.beginComputePass({
      label: 'Stroke Extrude Pass',
      timestampWrites: ctx.timestamp?.('stroke-extrude'),
    });
    pass.setPipeline(ctx.pipelineCache.getStrokeExtrudePipeline());

    for (const p of extrudable) {
      const segments = p.pointCount - 1;
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
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(segments / STROKE_EXTRUDE_WORKGROUP_SIZE));

      this.pending.push({ verts: vertsSlot, vertexCount: segments * STROKE_VERTS_PER_SEGMENT });
    }
    pass.end();
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
    // A collection whose every stroke is degenerate (<2 points) extruded nothing.
    if (this.pending.length === 0) return;

    const { device, pipelineCache, bufferRing, targetFormat } = ctx;
    // `encodePrepass` filtered degenerate strokes out of `pending` in the same
    // order; zip the draw params back onto the surviving entries.
    const strokes = args.params.strokes.filter((p) => p.pointCount - 1 >= 1);

    pass.setPipeline(pipelineCache.getStrokePipeline(targetFormat));
    for (let i = 0; i < this.pending.length; i++) {
      const p = strokes[i];
      const drawn = this.pending[i];

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
      // offset 32 (4B) hard_edge flag (u32 via the Uint32 view — same bytes, typed lane)
      uniformUintView[8] = p.antiAliased ? 0 : 1;

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

      pass.setVertexBuffer(0, drawn.verts.buffer, drawn.verts.offset, drawn.verts.size);
      pass.setBindGroup(0, bindGroup, [slot.offset]);
      // Group 1: the stroke's frozen selection coverage (or the 1×1 alpha=1 dummy
      // when unconstrained) — the fragment multiplies its coverage by it.
      pass.setBindGroup(1, pipelineCache.getStrokeConfinementBindGroup(args.confinementCoverages?.[i]));
      pass.draw(drawn.vertexCount);
    }

    this.pending = [];
  }
}

/** Engine built-in singleton — the logic-brush slot. */
export const strokeRenderer = new StrokeRenderer();
