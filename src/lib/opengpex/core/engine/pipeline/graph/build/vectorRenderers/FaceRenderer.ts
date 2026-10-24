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
 * FaceRenderer.ts — Vector render strategy: CPU-tessellated filled regions
 * (the vector spine's `face` strategy).
 *
 * Unlike `StrokeRenderer` (GPU compute extrusion from a point stream), ALL
 * geometry arrives prebuilt in `FaceParams.verts` — fill triangles from
 * `core/geometry/tessellate.ts` plus boundary edge quads — packed by the
 * plugin-side translator, which caches it against a content digest so the
 * tessellation cost is paid once per edit, not per frame. This renderer only
 * uploads the stream and issues two draws:
 *
 *   1. fill triangles  — `getFaceFillPipeline` (REPLACE blend)
 *   2. edge quads/joins — `getFaceEdgePipeline` (MAX blend, coverage union)
 *
 * Both fragment kinds live in one WGSL module (`shaders/face.ts`), split per
 * vertex by the `kind` attribute; the two PIPELINES exist because the blend
 * semantics differ (see PipelineCache notes).
 *
 * OUTPUT CONTRACT (identical to sdf/stroke): STRAIGHT-alpha, WORKING-gamut
 * linear-light pixels into the caller-cleared transient; no layer.opacity /
 * mask (downstream `drawLayer`'s job).
 *
 * @module core/gpu/graph/build/vectorRenderers/FaceRenderer
 */

import { GPUBufferUsage } from '@opengpex/editor/core/engine/gpu/constants';
import { BufferRing } from '@opengpex/editor/core/engine/gpu/resources/BufferRing';
import { FACE_UNIFORM_BUFFER_SIZE } from '@opengpex/editor/core/engine/gpu/shaders/face';
import type { FaceParams } from '../../../scene/Scene';
import type { VectorRenderer, VectorRenderContext, VectorRenderArgs } from './VectorRenderer';

/** Capacity of the private vertex ring (8 MiB ≈ 524k packed vertices). */
const FACE_RING_CAPACITY = 8 * 1024 * 1024;

/** Uniform scratch (48 bytes) — module-level, safe on the sync render path. */
const uniformData = new Float32Array(FACE_UNIFORM_BUFFER_SIZE / 4);

const NO_EDGE: readonly [number, number, number, number] = [0, 0, 0, 0];

export class FaceRenderer implements VectorRenderer {
  /** Pure coverage/colour output; never reads a composited backdrop. */
  readonly needsBackdrop = false;

  /** Private VERTEX ring for the packed stream (uploaded fresh every render). */
  private vertsRing: BufferRing | null = null;
  private ringDevice: GPUDevice | null = null;

  private ensureRing(device: GPUDevice): BufferRing {
    if (this.vertsRing && this.ringDevice === device) return this.vertsRing;
    this.vertsRing?.destroy();
    this.vertsRing = new BufferRing(
      device,
      FACE_RING_CAPACITY,
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      'Face Verts Ring',
    );
    this.ringDevice = device;
    return this.vertsRing;
  }

  render(pass: GPURenderPassEncoder, ctx: VectorRenderContext, args: VectorRenderArgs): void {
    if (args.params.renderer !== 'face') {
      throw new Error(`FaceRenderer received non-face params: ${args.params.renderer}`);
    }
    const m: FaceParams = args.params.face;
    if (m.vertexCount < 3) return;

    const { device, pipelineCache, bufferRing, targetFormat } = ctx;

    // offset 0 (16B) fill colour — working-gamut linear, straight alpha
    uniformData[0] = m.fillColor[0];
    uniformData[1] = m.fillColor[1];
    uniformData[2] = m.fillColor[2];
    uniformData[3] = m.fillColor[3];
    // offset 16 (16B) edge colour
    const edge = m.edgeColor ?? NO_EDGE;
    uniformData[4] = edge[0];
    uniformData[5] = edge[1];
    uniformData[6] = edge[2];
    uniformData[7] = edge[3];
    // offset 32 (8B) target size (NDC map), (4B) edge half width, (4B) pad
    uniformData[8] = m.width;
    uniformData[9] = m.height;
    uniformData[10] = m.strokeWidth / 2;

    const uniformSlot = bufferRing.writeSlot(uniformData);
    const vertsSlot = this.ensureRing(device).writeSlot(m.verts);

    const bindGroup = device.createBindGroup({
      layout: pipelineCache.getFaceBindGroupLayout(),
      label: 'Face BindGroup',
      entries: [
        {
          binding: 0,
          resource: {
            buffer: bufferRing.getBuffer(),
            offset: 0,
            size: FACE_UNIFORM_BUFFER_SIZE,
          },
        },
      ],
    });

    // Draw 1: fill triangles (kind 0 vertices, REPLACE blend).
    const fillStart = this.findKindRun(m, 0);
    if (fillStart) {
      pass.setPipeline(pipelineCache.getFaceFillPipeline(targetFormat));
      pass.setVertexBuffer(0, vertsSlot.buffer, vertsSlot.offset + fillStart.start * 16, fillStart.count * 16);
      pass.setBindGroup(0, bindGroup, [uniformSlot.offset]);
      pass.draw(fillStart.count);
    }

    // Draw 2: boundary edge quads/joins (kind 1 vertices, MAX blend).
    const edgeStart = this.findKindRun(m, 1);
    if (edgeStart) {
      pass.setPipeline(pipelineCache.getFaceEdgePipeline(targetFormat));
      pass.setVertexBuffer(0, vertsSlot.buffer, vertsSlot.offset + edgeStart.start * 16, edgeStart.count * 16);
      pass.setBindGroup(0, bindGroup, [uniformSlot.offset]);
      pass.draw(edgeStart.count);
    }
  }

  /**
   * The translator packs the stream CONTIGUOUSLY: all kind-0 vertices first,
   * then all kind-1 vertices. This returns the single run for `kind`, or null
   * when the stream holds none.
   */
  private findKindRun(m: FaceParams, kind: 0 | 1): { start: number; count: number } | null {
    // Scan for the first vertex of `kind`; the run extends to the next kind
    // switch (or the end). Streams are hundreds-to-tens-of-thousands of verts;
    // this linear scan per draw is noise next to the upload itself.
    let start = -1;
    let count = 0;
    for (let i = 0; i < m.vertexCount; i++) {
      if (m.verts[i * 4 + 3] === kind) {
        if (start < 0) start = i;
        count++;
      } else if (start >= 0) {
        break; // contiguous runs — first gap ends the run
      }
    }
    return start >= 0 ? { start, count } : null;
  }
}

/** Engine built-in singleton — the filled-region slot. */
export const faceRenderer = new FaceRenderer();
