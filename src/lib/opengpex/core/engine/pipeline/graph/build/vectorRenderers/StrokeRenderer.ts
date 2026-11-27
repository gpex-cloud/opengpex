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
 * STRAIGHT-alpha, WORKING-gamut (ProPhoto RGB) linear-light pixels. The caller clears
 * (or pre-populates via `prepareTransient`) the target first; this pass writes with
 * MAX_BLEND (associative per-stroke coverage union) and applies neither `layer.opacity`
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

import { GPUBufferUsage, GPUTextureUsage } from '@opengpex/editor/core/engine/gpu/constants';
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

const FLOATS_PER_POINT = 4;

const LIVE_CLEAR_COLOR: GPUColor = { r: 0, g: 0, b: 0, a: 0 };

interface LiveStrokeEntry {
  device: GPUDevice;
  texture: GPUTexture;
  width: number;
  height: number;
  format: GPUTextureFormat;
  committedPointCount: number;
  paramSig: string;
}

interface PendingDraw {
  verts: BufferSlot;
  vertexCount: number;
  strokeIndex: number;
}

interface PendingSolidify {
  entry: LiveStrokeEntry;
  verts: BufferSlot;
  vertexCount: number;
  stroke: StrokeParams;
  clearFirst: boolean;
}

function strokeParamSig(p: StrokeParams): string {
  const c = p.color;
  const conf = p.confinement
    ? `${p.confinement.antiAliased ? 1 : 0}:${p.confinement.feather ?? 0}:${p.confinement.rings.length}`
    : 'none';
  return `${c[0]},${c[1]},${c[2]},${c[3]}|${p.size}|${p.hardness}|${p.antiAliased ? 1 : 0}|${p.width}x${p.height}|${conf}`;
}

export class StrokeRenderer implements VectorRenderer {
  /** Stroke writes pure coverage/colour; it never reads a composited backdrop. */
  readonly needsBackdrop = false;

  /** Lazily-built storage rings for pts / verts (SEPARATE buffers — see capacity note). */
  private ptsRing: BufferRing | null = null;
  private vertsRing: BufferRing | null = null;
  private ringDevice: GPUDevice | null = null;
  private ringCapacity = STROKE_RING_CAPACITY;

  /** Per-layer persistent live textures holding monotonically solidified stroke prefixes. */
  private liveCache = new Map<string, LiveStrokeEntry>();
  private seenLiveIds = new Set<string>();

  /** Pending solidified segment batch to rasterize into `liveCache` in `prepareTransient`. */
  private pendingSolidify: PendingSolidify | null = null;

  /** Per-stroke (or tail-slice) verts slot + draw count, handed from `encodePrepass` to `render`. */
  private pending: PendingDraw[] = [];

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

  /** Destroy any live stroke textures not referenced during the current frame. */
  sweepLiveCache(): void {
    for (const [id, entry] of this.liveCache) {
      if (!this.seenLiveIds.has(id)) {
        entry.texture.destroy();
        this.liveCache.delete(id);
      }
    }
    this.seenLiveIds.clear();
  }

  /** Destroy all persistent live stroke textures (device loss / engine teardown). */
  clearLiveCache(): void {
    for (const entry of this.liveCache.values()) {
      entry.texture.destroy();
    }
    this.liveCache.clear();
    this.seenLiveIds.clear();
    this.pendingSolidify = null;
    this.pending = [];
  }

  private acquireLiveEntry(
    layerId: string,
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat,
    paramSig: string,
    solidifiedCount: number,
  ): { entry: LiveStrokeEntry; reset: boolean } {
    const existing = this.liveCache.get(layerId);
    if (
      existing &&
      existing.device === device &&
      existing.width === width &&
      existing.height === height &&
      existing.format === format
    ) {
      if (existing.paramSig !== paramSig || solidifiedCount < existing.committedPointCount) {
        existing.committedPointCount = 0;
        existing.paramSig = paramSig;
        return { entry: existing, reset: true };
      }
      return { entry: existing, reset: false };
    }
    existing?.texture.destroy();
    const texture = device.createTexture({
      size: [width, height, 1],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      label: `Stroke Live Cache (${layerId})`,
    });
    const entry: LiveStrokeEntry = {
      device,
      texture,
      width,
      height,
      format,
      committedPointCount: 0,
      paramSig,
    };
    this.liveCache.set(layerId, entry);
    return { entry, reset: true };
  }

  /**
   * Compute prepass — upload the trajectory (or only the incremental new/tail
   * slices for a live stroke), allocate the ribbon verts, and run `cs_extrude`.
   */
  encodePrepass(encoder: GPUCommandEncoder, ctx: VectorRenderContext, args: VectorRenderArgs): void {
    if (args.params.renderer !== 'stroke') {
      throw new Error(`StrokeRenderer received non-stroke params: ${args.params.renderer}`);
    }
    const strokes: readonly StrokeParams[] = args.params.strokes;
    this.pending = [];
    this.pendingSolidify = null;

    // Incremental live-stroke mode: single stroke carrying `solidifiedCount`.
    if (
      !args.isExport &&
      args.layerId &&
      args.targetExtent &&
      strokes.length === 1 &&
      strokes[0].solidifiedCount !== undefined
    ) {
      const p = strokes[0];
      const [reqW, reqH] = args.targetExtent;
      const sig = strokeParamSig(p);
      const targetCommitted = Math.min(p.solidifiedCount ?? 0, p.pointCount);
      const { entry, reset } = this.acquireLiveEntry(
        args.layerId,
        ctx.device,
        reqW,
        reqH,
        ctx.targetFormat,
        sig,
        targetCommitted,
      );
      this.seenLiveIds.add(args.layerId);

      const prevCommitted = entry.committedPointCount;
      let solidifySlice: Float32Array | null = null;
      let solidifySegments = 0;
      const clearFirst = reset || prevCommitted === 0;
      if (targetCommitted > prevCommitted && targetCommitted >= 2) {
        const startIdx = prevCommitted >= 2 ? prevCommitted - 1 : 0;
        const sliceCount = targetCommitted - startIdx;
        if (sliceCount >= 2) {
          solidifySlice = p.points.subarray(startIdx * FLOATS_PER_POINT, targetCommitted * FLOATS_PER_POINT);
          solidifySegments = sliceCount - 1;
          entry.committedPointCount = targetCommitted;
        }
      }

      const tailStart = entry.committedPointCount >= 2 ? entry.committedPointCount - 1 : 0;
      const tailCount = p.pointCount - tailStart;
      let tailSlice: Float32Array | null = null;
      let tailSegments = 0;
      if (tailCount >= 2) {
        tailSlice = p.points.subarray(tailStart * FLOATS_PER_POINT, p.pointCount * FLOATS_PER_POINT);
        tailSegments = tailCount - 1;
      }

      if (solidifySegments === 0 && tailSegments === 0) return;

      const ptsBytes = (solidifySlice?.byteLength ?? 0) + (tailSlice?.byteLength ?? 0);
      const vertsBytes = (solidifySegments + tailSegments) * STROKE_VERTS_PER_SEGMENT * STROKE_VERTEX_STRIDE;
      this.growRingsIfNeeded(ctx.device, Math.max(ptsBytes, vertsBytes));
      const { pts: ptsRing, verts: vertsRing } = this.ensureRings(ctx.device);

      const pass = encoder.beginComputePass({
        label: 'Stroke Extrude Pass (Incremental)',
        timestampWrites: ctx.timestamp?.('stroke-extrude'),
      });
      pass.setPipeline(ctx.pipelineCache.getStrokeExtrudePipeline());

      if (solidifySlice && solidifySegments > 0) {
        const vertsSlot = this.dispatchExtrudeSlice(pass, ctx, ptsRing, vertsRing, solidifySlice, solidifySegments);
        this.pendingSolidify = {
          entry,
          verts: vertsSlot,
          vertexCount: solidifySegments * STROKE_VERTS_PER_SEGMENT,
          stroke: p,
          clearFirst,
        };
      }
      if (tailSlice && tailSegments > 0) {
        const vertsSlot = this.dispatchExtrudeSlice(pass, ctx, ptsRing, vertsRing, tailSlice, tailSegments);
        this.pending.push({
          verts: vertsSlot,
          vertexCount: tailSegments * STROKE_VERTS_PER_SEGMENT,
          strokeIndex: 0,
        });
      }
      pass.end();
      return;
    }

    const extrudable: { stroke: StrokeParams; index: number }[] = [];
    for (let i = 0; i < strokes.length; i++) {
      if (strokes[i].pointCount - 1 >= 1) {
        extrudable.push({ stroke: strokes[i], index: i });
      }
    }
    if (extrudable.length === 0) return;

    let ptsBytes = 0;
    let vertsBytes = 0;
    for (const { stroke } of extrudable) {
      ptsBytes += stroke.points.byteLength;
      vertsBytes += (stroke.pointCount - 1) * STROKE_VERTS_PER_SEGMENT * STROKE_VERTEX_STRIDE;
    }
    this.growRingsIfNeeded(ctx.device, Math.max(ptsBytes, vertsBytes));
    const { pts: ptsRing, verts: vertsRing } = this.ensureRings(ctx.device);

    const pass = encoder.beginComputePass({
      label: 'Stroke Extrude Pass',
      timestampWrites: ctx.timestamp?.('stroke-extrude'),
    });
    pass.setPipeline(ctx.pipelineCache.getStrokeExtrudePipeline());

    for (const { stroke, index } of extrudable) {
      const segments = stroke.pointCount - 1;
      const vertsSlot = this.dispatchExtrudeSlice(pass, ctx, ptsRing, vertsRing, stroke.points, segments);
      this.pending.push({
        verts: vertsSlot,
        vertexCount: segments * STROKE_VERTS_PER_SEGMENT,
        strokeIndex: index,
      });
    }
    pass.end();
  }

  private growRingsIfNeeded(device: GPUDevice, frameNeed: number): void {
    if (frameNeed <= this.ringCapacity) return;
    const maxBuffer = device.limits.maxBufferSize;
    this.ringCapacity = Math.min(
      maxBuffer,
      Math.max(Math.ceil((frameNeed * 2) / (1024 * 1024)) * (1024 * 1024), STROKE_RING_CAPACITY),
    );
    console.warn(`Stroke rings grown to ${this.ringCapacity} bytes for a ${frameNeed}-byte frame`);
  }

  private dispatchExtrudeSlice(
    pass: GPUComputePassEncoder,
    ctx: VectorRenderContext,
    ptsRing: BufferRing,
    vertsRing: BufferRing,
    pointsSlice: Float32Array,
    segments: number,
  ): BufferSlot {
    const ptsSlot = ptsRing.writeSlot(pointsSlice);
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
    return vertsSlot;
  }

  /**
   * Flush newly solidified segments into the persistent live texture and copy
   * its contents into `args.targetTexture` so the main vector pass only draws
   * the dynamic tail with `loadOp: 'load'`.
   */
  prepareTransient(
    encoder: GPUCommandEncoder,
    ctx: VectorRenderContext,
    args: VectorRenderArgs & { readonly targetTexture: GPUTexture },
  ): boolean {
    if (this.pendingSolidify) {
      const { entry, verts, vertexCount, stroke, clearFirst } = this.pendingSolidify;
      this.pendingSolidify = null;
      const livePass = encoder.beginRenderPass({
        label: `Stroke Live Solidify (${args.layerId ?? 'live'})`,
        colorAttachments: [
          {
            view: entry.texture.createView(),
            clearValue: LIVE_CLEAR_COLOR,
            loadOp: clearFirst ? 'clear' : 'load',
            storeOp: 'store',
          },
        ],
      });
      livePass.setViewport(0, 0, entry.width, entry.height, 0, 1);
      livePass.setPipeline(ctx.pipelineCache.getStrokePipeline(entry.format));
      this.drawStrokeSlice(livePass, ctx, stroke, verts, vertexCount, args.confinementCoverages?.[0]);
      livePass.end();
    }

    if (args.isExport || !args.layerId) return false;
    const entry = this.liveCache.get(args.layerId);
    if (!entry || entry.committedPointCount < 2) return false;

    encoder.copyTextureToTexture(
      { texture: entry.texture },
      { texture: args.targetTexture },
      [entry.width, entry.height, 1],
    );
    return true;
  }

  /**
   * Paint draw — bind the ribbon vertex buffer produced by `encodePrepass` and
   * rasterize soft-edge coverage into the ACTIVE render pass.
   */
  render(pass: GPURenderPassEncoder, ctx: VectorRenderContext, args: VectorRenderArgs): void {
    if (args.params.renderer !== 'stroke') {
      throw new Error(`StrokeRenderer received non-stroke params: ${args.params.renderer}`);
    }
    if (this.pending.length === 0) return;

    const strokes = args.params.strokes;
    pass.setPipeline(ctx.pipelineCache.getStrokePipeline(ctx.targetFormat));
    for (const drawn of this.pending) {
      const p = strokes[drawn.strokeIndex];
      this.drawStrokeSlice(
        pass,
        ctx,
        p,
        drawn.verts,
        drawn.vertexCount,
        args.confinementCoverages?.[drawn.strokeIndex],
      );
    }

    this.pending = [];
  }

  private drawStrokeSlice(
    pass: GPURenderPassEncoder,
    ctx: VectorRenderContext,
    p: StrokeParams,
    verts: BufferSlot,
    vertexCount: number,
    confinementCoverage: GPUTextureView | undefined,
  ): void {
    const { device, pipelineCache, bufferRing } = ctx;
    uniformData[0] = p.color[0];
    uniformData[1] = p.color[1];
    uniformData[2] = p.color[2];
    uniformData[3] = p.color[3];
    uniformData[4] = p.width;
    uniformData[5] = p.height;
    uniformData[6] = p.size;
    uniformData[7] = p.hardness;
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

    pass.setVertexBuffer(0, verts.buffer, verts.offset, verts.size);
    pass.setBindGroup(0, bindGroup, [slot.offset]);
    pass.setBindGroup(1, pipelineCache.getStrokeConfinementBindGroup(confinementCoverage));
    pass.draw(vertexCount);
  }
}

/** Engine built-in singleton — the logic-brush slot. */
export const strokeRenderer = new StrokeRenderer();
