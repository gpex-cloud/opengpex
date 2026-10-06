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
 * prepareVmaskSources.ts — GPU compute fill-pass orchestration for POLYGON vector
 * masks. Bakes each polygon `vmask` into a resident `rgba8unorm` coverage
 * texture BEFORE any composite render pass opens (WebGPU forbids a compute pass while
 * a render pass is active — same constraint the vector spine's `encodePrepass` obeys).
 * The analytic sub-path (single rect/ellipse) is NOT handled here — it solves
 * per-fragment in `layer.ts`/`blend.ts` with no intermediate texture.
 *
 * ── OWNED, CROSS-FRAME, EXACT-SIZE TEXTURE CACHE ──
 * The baked coverage is a build-local product, NOT part of the scene descriptor. It
 * is cached here keyed by {@link getVmaskKey} — a digest of the sub-mask geometry
 * (layer-local rings) + feather + invert + the mask texel dims. The key is
 * POSITION-FREE: the rings are layer-local, so panning the layer around the canvas
 * (its world `transform`) never changes the key and never re-bakes. A key hit reuses
 * the cached texture and SKIPS the compute dispatch entirely — this is what kills the
 * per-move re-rasterise that the deleted CPU `renderVectorMasksToBitmap` path suffered.
 *
 * The textures are OWNED (allocated with `device.createTexture`, EXACT-size), not
 * pooled: the pool reuses by shape and does not preserve content across frames, so it
 * could never deliver zero-rebake-on-move. Exact-size (allocated == content) also keeps
 * `maxU=maxV=1`, so the sampling side (`layer.ts` HAS_VMASK_TEX) reads `mask_uv∈[0,1]`
 * with no POT sub-rect scaling. Entries whose layer is gone this frame are swept and
 * destroyed; a device change clears everything. `clearVmaskCache()` is the teardown
 * seam, wired into `WebGpuEngine.destroy()` (replacing the old `clearVectorMaskCache`).
 *
 * ── PER-LAYER ENCODE ──
 * Flatten every sub-mask's rings into one shared edge buffer (each ring closed,
 * last→first appended), build a sub-mask table of `[edge_start, edge_count,
 * feather, flags]` slices (flags: bit0 = inverted, bit1 = antiAliased), upload
 * both to private storage rings + the 32B uniform, then
 * `dispatchWorkgroups(ceil(w/8), ceil(h/8))`. The shader intersects the sub-masks
 * (`coverage = Π cov_m`, each invert baked before the product — v1 `ctx.clip()` intersection).
 *
 * @module core/gpu/graph/build/prepareVmaskSources
 */

import type { CompiledScene } from '../SceneCompiler';
import { GPUBufferUsage, GPUTextureUsage } from '@opengpex/editor/core/engine/gpu/constants';
import { BufferRing } from '@opengpex/editor/core/engine/gpu/resources/BufferRing';
import { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import {
  VMASK_WORKGROUP_SIZE,
  VMASK_UNIFORM_SIZE,
  VMASK_SUBMASK_SIZE,
} from '@opengpex/editor/core/engine/gpu/shaders/vmask';
import { vectorTransientSize } from '../support/vectorTransient';
import type { VectorSubMask } from '../../scene/Scene';
import type { BuildContext } from './types';

/** Capacity of each private storage/uniform ring (2 MiB — polygon masks are small). */
const VMASK_RING_CAPACITY = 2 * 1024 * 1024;

/**
 * Position-free cache key for a polygon vmask's baked coverage. Digests the
 * sub-mask geometry (layer-local rings) + per-mask feather/invert/antiAliased +
 * the mask texel dims. EXCLUDES the layer's world transform: the rings are
 * layer-local, so a pan/move produces the identical key and reuses the baked
 * texture (zero re-bake). A geometry edit, feather/invert/AA toggle, or a resize
 * (dims change) all flip the key.
 *
 * Exported for stability golden test (same geometry + different transform ⇒ same
 * key; any geometry/dims change ⇒ different key).
 */
export function getVmaskKey(
  subMasks: readonly VectorSubMask[],
  maskW: number,
  maskH: number,
): string {
  const parts = subMasks.map((sm) => {
    const rings = sm.rings
      .map((ring) => ring.map((p) => `${p[0]},${p[1]}`).join(' '))
      .join('|');
    return `${sm.featherPx}_${sm.inverted ? 1 : 0}_${sm.antiAliased ? 1 : 0}_${sm.distBiasPx ?? 0}:${rings}`;
  });
  return `${maskW}x${maskH}#${parts.join(';')}`;
}

/** One live owned coverage texture kept across frames until its key changes or it is swept. */
interface VmaskCacheEntry {
  key: string;
  texture: GPUTexture;
  width: number;
  height: number;
}

/**
 * Module-level owned cache (mirrors the `strokeRenderer` singleton posture): one entry
 * per layer id, holding the last baked coverage texture. Single-threaded synchronous
 * render path, so no locking is needed.
 */
class VmaskCache {
  private device: GPUDevice | null = null;
  private readonly entries = new Map<string, VmaskCacheEntry>();
  private edgesRing: BufferRing | null = null;
  private tableRing: BufferRing | null = null;
  private uniformRing: BufferRing | null = null;

  /** Lazily (re)create the private rings, dropping everything on a device change. */
  private ensureRings(device: GPUDevice): void {
    if (this.device === device && this.edgesRing && this.tableRing && this.uniformRing) return;
    // Device changed (or first use) — the old textures/rings belong to a dead device.
    if (this.device !== device) this.disposeTextures();
    this.edgesRing?.destroy();
    this.tableRing?.destroy();
    this.uniformRing?.destroy();
    this.edgesRing = new BufferRing(
      device,
      VMASK_RING_CAPACITY,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      'Vmask Edges Ring',
    );
    this.tableRing = new BufferRing(
      device,
      VMASK_RING_CAPACITY,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      'Vmask SubMask Table Ring',
    );
    // Isolated uniform ring so a busy composite frame's layer-uniform writes on the
    // SHARED BufferRing can never wrap over and clobber these fill uniforms (they are
    // read at submit time, AFTER every queued writeBuffer has landed).
    this.uniformRing = new BufferRing(
      device,
      VMASK_RING_CAPACITY,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      'Vmask Uniform Ring',
    );
    this.device = device;
  }

  private disposeTextures(): void {
    for (const e of this.entries.values()) e.texture.destroy();
    this.entries.clear();
  }

  /**
   * Bake (or reuse) the polygon coverage for one layer and return its owned texture.
   * Records the compute dispatch onto `encoder` when a bake is needed; a key hit is a
   * pure lookup with no GPU work.
   */
  prepare(
    encoder: GPUCommandEncoder,
    ctx: BuildContext,
    layerId: string,
    subMasks: readonly VectorSubMask[],
    maskW: number,
    maskH: number,
  ): LayerTexture {
    const { device } = ctx;
    this.ensureRings(device);

    const key = getVmaskKey(subMasks, maskW, maskH);
    const existing = this.entries.get(layerId);
    const isCacheHit = !!(existing && existing.key === key && existing.width === maskW && existing.height === maskH);
    if (isCacheHit) {
      return this.wrap(existing!);
    }

    // Key/dims changed → the old texture is stale. Destroy and re-bake into a fresh
    // exact-size owned texture.
    existing?.texture.destroy();
    const texture = device.createTexture({
      size: [maskW, maskH, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: `Vmask (${layerId})`,
    });
    const entry: VmaskCacheEntry = { key, texture, width: maskW, height: maskH };
    this.entries.set(layerId, entry);

    this.encodeFill(encoder, ctx, layerId, subMasks, maskW, maskH, texture);
    return this.wrap(entry);
  }

  /** Encode the compute fill-pass for a fresh texture. */
  private encodeFill(
    encoder: GPUCommandEncoder,
    ctx: BuildContext,
    layerId: string,
    subMasks: readonly VectorSubMask[],
    maskW: number,
    maskH: number,
    texture: GPUTexture,
  ): void {
    const { device, pipelineCache } = ctx;
    const edgesRing = this.edgesRing!;
    const tableRing = this.tableRing!;
    const uniformRing = this.uniformRing!;

    // ── Flatten edges + build the sub-mask table ──
    // Each sub-mask owns a [edge_start, edge_start+edge_count) slice; every ring is
    // closed (last vertex → first). Edge = (a.x, a.y, b.x, b.y) in layer-local px.
    // Slot 2 is the feather f32; slot 3 packs the per-mask flags: bit0 = inverted,
    // bit1 = antiAliased; slot 4 is the signed distance bias f32 (cut-to-layer
    // seam backing; 0 for plain masks).
    const edgeVals: number[] = [];
    const table = new ArrayBuffer(Math.max(1, subMasks.length) * VMASK_SUBMASK_SIZE);
    const tableU32 = new Uint32Array(table);
    const tableF32 = new Float32Array(table);
    for (let m = 0; m < subMasks.length; m++) {
      const sm = subMasks[m];
      const edgeStart = edgeVals.length / 4;
      for (const ring of sm.rings) {
        const n = ring.length;
        if (n < 3) continue; // degenerate ring has no area → contributes no edges
        for (let i = 0; i < n; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % n];
          edgeVals.push(a[0], a[1], b[0], b[1]);
        }
      }
      const edgeCount = edgeVals.length / 4 - edgeStart;
      tableU32[m * 5 + 0] = edgeStart;
      tableU32[m * 5 + 1] = edgeCount;
      tableF32[m * 5 + 2] = sm.featherPx;
      tableU32[m * 5 + 3] = (sm.inverted ? 1 : 0) | (sm.antiAliased ? 2 : 0);
      tableF32[m * 5 + 4] = sm.distBiasPx ?? 0;
    }
    // WebGPU rejects a zero-sized storage binding; when every ring was degenerate,
    // pad one dummy edge so the buffer is non-empty (the table's edge_count is 0, so
    // the shader loop never reads it → coverage falls through to the empty-polygon case).
    const edges = new Float32Array(edgeVals.length > 0 ? edgeVals : [0, 0, 0, 0]);

    const edgesSlot = edgesRing.writeSlot(edges);
    const tableSlot = tableRing.writeSlot(new Uint8Array(table));

    // ── Uniform (32B): dims, mask_count, px_scale (texel grid → layer-local px) ──
    const uni = new ArrayBuffer(VMASK_UNIFORM_SIZE);
    const uniU32 = new Uint32Array(uni);
    const uniF32 = new Float32Array(uni);
    uniU32[0] = maskW; // dims.x        @0
    uniU32[1] = maskH; // dims.y        @4
    uniU32[2] = subMasks.length; // mask_count @8
    uniU32[3] = 0; // _pad0             @12
    // px_scale maps texel (x+0.5, y+0.5) → layer-local px: maskW texels cover the
    // layer's logical width, so scale = logicalWidth / maskW (the inverse supersample
    // factor; 1 on the interactive path). Computed by the caller and stashed on the
    // instance so `encodeFill` need not grow a wider param list.
    uniF32[4] = this.pxScaleX; // px_scale.x  @16
    uniF32[5] = this.pxScaleY; // px_scale.y  @20
    uniF32[6] = 0; // _pad1.x           @24
    uniF32[7] = 0; // _pad1.y           @28
    const uniSlot = uniformRing.writeSlot(new Uint8Array(uni));

    const bindGroup = device.createBindGroup({
      label: `Vmask BindGroup (${layerId})`,
      layout: pipelineCache.getVmaskBindGroupLayout(),
      entries: [
        { binding: 0, resource: { buffer: uniSlot.buffer, offset: uniSlot.offset, size: VMASK_UNIFORM_SIZE } },
        { binding: 1, resource: { buffer: edgesSlot.buffer, offset: edgesSlot.offset, size: edgesSlot.size } },
        { binding: 2, resource: { buffer: tableSlot.buffer, offset: tableSlot.offset, size: tableSlot.size } },
        { binding: 3, resource: texture.createView() },
      ],
    });

    const pass = encoder.beginComputePass({
      label: `Vmask Pass (${layerId})`,
      timestampWrites: ctx.gpuTimer?.pass('vmask'),
    });
    pass.setPipeline(pipelineCache.getVmaskPipeline());
    // Static uniform binding (offset baked into the bind group's resource.offset above),
    // so NO dynamic offset array here — passing one would add uniSlot.offset a second
    // time (physical = resource.offset + dynamicOffset), reading past the written slot.
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(maskW / VMASK_WORKGROUP_SIZE),
      Math.ceil(maskH / VMASK_WORKGROUP_SIZE),
    );
    pass.end();
  }

  // px_scale for the CURRENT `prepare` call, threaded through `encodeFill` to avoid a
  // wide param list. Set by `prepare` before it calls `encodeFill`.
  private pxScaleX = 1;
  private pxScaleY = 1;

  setPxScale(x: number, y: number): void {
    this.pxScaleX = x;
    this.pxScaleY = y;
  }

  private wrap(entry: VmaskCacheEntry): LayerTexture {
    // Exact-size owned texture ⇒ allocated == content ⇒ maxU=maxV=1.
    return new LayerTexture({
      texture: entry.texture,
      width: entry.width,
      height: entry.height,
      allocatedWidth: entry.width,
      allocatedHeight: entry.height,
      format: 'rgba8unorm',
    });
  }

  /** Destroy every entry whose layer id is not in `seen` this frame. */
  sweep(seen: Set<string>): void {
    for (const [id, entry] of this.entries) {
      if (!seen.has(id)) {
        entry.texture.destroy();
        this.entries.delete(id);
      }
    }
  }

  /** Teardown seam — destroy all textures + rings (WebGpuEngine.destroy()). */
  clear(): void {
    this.disposeTextures();
    this.edgesRing?.destroy();
    this.tableRing?.destroy();
    this.uniformRing?.destroy();
    this.edgesRing = null;
    this.tableRing = null;
    this.uniformRing = null;
    this.device = null;
  }
}

const cache = new VmaskCache();

/**
 * Bake every POLYGON vmask in the scene into an owned coverage texture, recorded onto
 * `encoder` BEFORE the composite render passes open, and populate `out` keyed by layer
 * id. Analytic vmasks are skipped (per-fragment). Sweeps entries whose layer vanished.
 *
 * @param exportScale physical-texels-per-logical-px (from `vectorExportScale`; [1,1]
 *                    interactive). The coverage texture is sized `ceil(logical × scale)`
 *                    so a 2×/4× export bakes a supersampled mask edge.
 */
export function prepareVmaskSources(
  encoder: GPUCommandEncoder,
  compiled: CompiledScene,
  ctx: BuildContext,
  out: Map<string, LayerTexture>,
  exportScale: readonly [number, number],
): void {
  const seen = new Set<string>();
  for (const layer of compiled.scene.layers) {
    const vmask = layer.vmask;
    if (!vmask || vmask.kind !== 'polygon') continue;
    if (vmask.subMasks.length === 0) continue;

    const logicalW = Math.max(1, layer.width ?? 1);
    const logicalH = Math.max(1, layer.height ?? 1);
    const [maskW, maskH] = vectorTransientSize(logicalW, logicalH, exportScale);

    // px_scale = logical / mask (inverse supersample). The shader's `p = (gid+0.5) *
    // px_scale` then lands in the layer-local px space the rings were emitted in.
    cache.setPxScale(logicalW / maskW, logicalH / maskH);

    out.set(layer.id, cache.prepare(encoder, ctx, layer.id, vmask.subMasks, maskW, maskH));
    seen.add(layer.id);
  }
  cache.sweep(seen);
}

/**
 * Release all owned vmask coverage textures + private rings. Call on engine teardown
 * (WebGpuEngine.destroy()) so the GPU textures do not leak — the replacement for the
 * deleted `clearVectorMaskCache()` (which freed the old CPU ImageBitmap cache).
 */
export function clearVmaskCache(): void {
  cache.clear();
}
