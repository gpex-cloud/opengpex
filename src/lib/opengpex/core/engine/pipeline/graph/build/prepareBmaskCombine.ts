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
 * prepareBmaskCombine.ts — GPU compute combine-pass orchestration for bitmap
 * masks (eraser/restore). Bakes every enabled bmask record of a layer into ONE
 * combined coverage texture BEFORE any composite render pass opens (compute
 * passes cannot nest inside a render pass — same constraint/precedent as the
 * polygon vmask fill-pass in `prepareVmaskSources.ts`, whose owned-cache
 * posture this module mirrors).
 *
 * ── WHY A COMBINE PASS ──
 * The restore inverted-record architecture (plan §9 阶段一) needs the two-family
 * combine `vis = max(Π erase αᵢ, max(1 − α_restore j))`, which a pure multiply
 * stack cannot express, and removes the retired 4-records-per-layer slot cap.
 * With no inverted record (today's only shape) the output equals the plain
 * coverage product — pixel-identical to the retired stack slots.
 *
 * ── OWNED, CROSS-FRAME, EXACT-SIZE TEXTURE CACHE ──
 * The combined texture is a build-local product keyed by
 * {@link getBmaskCombineKey}: the FULL record enumeration
 * `(maskId, epoch, inverted, hard)` (isomorphic to `compositeSignature`'s
 * bmaskSig) plus the output texel dims. A key hit skips the dispatch entirely;
 * a static frame never re-combines. A live fast-override stroke re-uploads its
 * record texture with a bumped epoch every frame, so the key changes and the
 * layer re-combines — the plan's "live preview re-combines per frame" cost.
 *
 * The textures are OWNED (device.createTexture, EXACT-size), not pooled (the
 * pool does not preserve content across frames). Entries whose layer is gone
 * this frame are swept and destroyed; a device change clears everything.
 * `clearBmaskCombineCache()` is the teardown seam, wired into
 * `WebGpuEngine.destroy()` beside `clearVmaskCache()`.
 *
 * ── IDENTITY FAST PATH ──
 * A single SOFT erase record (today's dominant shape: one eraser mask, or one
 * live override) combines to its own alpha — the record's resident texture is
 * returned as-is, zero dispatches, byte-identical to the pre-combine pipeline.
 * Only hard / inverted / multi-record layers pay a combine.
 *
 * @module core/gpu/graph/build/prepareBmaskCombine
 */

import type { CompiledScene } from '../SceneCompiler';
import { GPUBufferUsage, GPUTextureUsage } from '@opengpex/editor/core/engine/gpu/constants';
import { BufferRing } from '@opengpex/editor/core/engine/gpu/resources/BufferRing';
import { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import {
  BMASK_COMBINE_UNIFORM_SIZE,
  BMASK_COMBINE_WORKGROUP_SIZE,
  BMASK_COMBINE_FLAG_HARD,
  BMASK_COMBINE_FLAG_RESTORE,
  BMASK_COMBINE_FLAG_FIRST,
  BMASK_COMBINE_FLAG_FINAL,
} from '@opengpex/editor/core/engine/gpu/shaders/bmaskCombine';
import type { BitmapMaskRecord } from '../../scene/Scene';
import type { BuildContext } from './types';

/** Capacity of the private uniform ring (combine uniforms are 32B each). */
const BMASK_COMBINE_RING_CAPACITY = 64 * 1024;

/**
 * Position-free cache key for a layer's combined bmask texture: the FULL record
 * enumeration `(maskId, epoch, inverted, hard)` — isomorphic to
 * `compositeSignature`'s bmaskSig — plus the output texel dims. ANY record
 * added, removed, re-baked (epoch bump), enabled-toggled, or hard/inverted-bit
 * change flips the key; a static frame reproduces the same key and reuses the
 * baked texture. Exported for stability tests.
 */
export function getBmaskCombineKey(
  records: readonly BitmapMaskRecord[],
  epochs: readonly number[],
  outW: number,
  outH: number,
): string {
  const parts = records.map(
    (r, i) => `${r.maskId}:${epochs[i]}:${r.inverted ? 1 : 0}:${r.hard ? 1 : 0}`,
  );
  return `${outW}x${outH}#${parts.join(';')}`;
}

/** One live owned texture set kept across frames until its key changes or it is swept. */
interface BmaskCombineCacheEntry {
  key: string;
  width: number;
  height: number;
  /** Final combined coverage, red channel = vis. Sampled by the layer/blend shaders. */
  output: GPUTexture;
  /** Ping-pong accumulators carrying (erase product, restore max) between folds. */
  ping: GPUTexture;
  pong: GPUTexture;
}

/** One resolved record ready to fold: the scene record plus its resident texture. */
interface ResolvedRecord {
  record: BitmapMaskRecord;
  texture: LayerTexture;
}

class BmaskCombineCache {
  private device: GPUDevice | null = null;
  private readonly entries = new Map<string, BmaskCombineCacheEntry>();
  private uniformRing: BufferRing | null = null;

  /** Lazily (re)create the private uniform ring, dropping everything on a device change. */
  private ensureRing(device: GPUDevice): void {
    if (this.device === device && this.uniformRing) return;
    // Device changed (or first use) — the old textures/ring belong to a dead device.
    if (this.device !== device) this.disposeTextures();
    this.uniformRing?.destroy();
    this.uniformRing = new BufferRing(
      device,
      BMASK_COMBINE_RING_CAPACITY,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      'Bmask Combine Uniform Ring',
    );
    this.device = device;
  }

  private disposeTextures(): void {
    for (const e of this.entries.values()) {
      e.output.destroy();
      e.ping.destroy();
      e.pong.destroy();
    }
    this.entries.clear();
  }

  /**
   * Combine (or reuse) the layer's bmask records into one coverage texture.
   * Returns the record texture itself for the single-soft-erase identity fast
   * path; otherwise an owned combined texture cached under `layerId`.
   * Returns undefined when NO record resolved (the layer renders unmasked).
   */
  prepare(
    encoder: GPUCommandEncoder,
    ctx: BuildContext,
    layerId: string,
    records: readonly BitmapMaskRecord[],
  ): LayerTexture | undefined {
    const { device, assets } = ctx;

    // Resolve every record's resident texture (uploaded by SceneAssembler's
    // per-record upload channel before this build phase runs). An unresolved
    // record is skipped — the multiply/max identity the retired stack slots used.
    const resolved: ResolvedRecord[] = [];
    for (const record of records) {
      const texture = assets.get(record.maskId);
      if (texture) resolved.push({ record, texture });
    }
    if (resolved.length === 0) return undefined;

    // Identity fast path: one soft erase record IS its own coverage.
    if (
      resolved.length === 1 &&
      !resolved[0].record.hard &&
      !resolved[0].record.inverted
    ) {
      return resolved[0].texture;
    }

    this.ensureRing(device);

    // The FIRST record (the live override mid-stroke, else the newest enabled
    // record — the pre-combine "primary") anchors the output dims.
    const anchor = resolved[0].texture;
    const outW = Math.max(1, anchor.width);
    const outH = Math.max(1, anchor.height);
    const epochs = resolved.map(({ record }) => ctx.getAssetEpoch?.(record.maskId) ?? 0);
    const key = getBmaskCombineKey(
      resolved.map(({ record }) => record),
      epochs,
      outW,
      outH,
    );

    const existing = this.entries.get(layerId);
    const isCacheHit = !!(existing && existing.key === key && existing.width === outW && existing.height === outH);
    if (isCacheHit) {
      return this.wrap(existing!);
    }

    // Key/dims changed → the old texture set is stale. Destroy and re-bake.
    if (existing) {
      existing.output.destroy();
      existing.ping.destroy();
      existing.pong.destroy();
    }
    const texUsage =
      GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    const mkTex = (label: string) =>
      device.createTexture({ size: [outW, outH, 1], format: 'rgba8unorm', usage: texUsage, label });
    const entry: BmaskCombineCacheEntry = {
      key,
      width: outW,
      height: outH,
      output: mkTex(`Bmask Combined (${layerId})`),
      ping: mkTex(`Bmask Combine Ping (${layerId})`),
      pong: mkTex(`Bmask Combine Pong (${layerId})`),
    };
    this.entries.set(layerId, entry);

    this.encodeFolds(encoder, ctx, layerId, resolved, entry, outW, outH);
    return this.wrap(entry);
  }

  /** Encode one compute fold per record + the final fold into the output texture. */
  private encodeFolds(
    encoder: GPUCommandEncoder,
    ctx: BuildContext,
    layerId: string,
    resolved: readonly ResolvedRecord[],
    entry: BmaskCombineCacheEntry,
    outW: number,
    outH: number,
  ): void {
    const { device, pipelineCache } = ctx;
    const uniformRing = this.uniformRing!;
    const last = resolved.length - 1;

    for (let i = 0; i <= last; i++) {
      const { record, texture } = resolved[i];
      const isFirst = i === 0;
      const isFinal = i === last;
      // Intermediate folds alternate ping/pong; the final fold lands in `output`.
      const dest = isFinal
        ? entry.output
        : (i % 2 === 0 ? entry.ping : entry.pong);
      // The previous fold's output texture; inert (record texture placeholder)
      // on the first fold, whose accumulator starts from the identity pair.
      const prevAccView = isFirst
        ? texture.view
        : ((i - 1) % 2 === 0 ? entry.ping : entry.pong).createView();

      let flags = 0;
      if (record.hard) flags |= BMASK_COMBINE_FLAG_HARD;
      if (record.inverted) flags |= BMASK_COMBINE_FLAG_RESTORE;
      if (isFirst) flags |= BMASK_COMBINE_FLAG_FIRST;
      if (isFinal) flags |= BMASK_COMBINE_FLAG_FINAL;

      const uni = new ArrayBuffer(BMASK_COMBINE_UNIFORM_SIZE);
      const uniU32 = new Uint32Array(uni);
      uniU32[0] = outW; // out_dims.x     @0
      uniU32[1] = outH; // out_dims.y     @4
      uniU32[2] = Math.max(1, texture.width); // rec_dims.x @8
      uniU32[3] = Math.max(1, texture.height); // rec_dims.y @12
      uniU32[4] = flags; //               @16
      const uniSlot = uniformRing.writeSlot(new Uint8Array(uni));

      const bindGroup = device.createBindGroup({
        label: `Bmask Combine BindGroup (${layerId} #${i})`,
        layout: pipelineCache.getBmaskCombineBindGroupLayout(),
        entries: [
          { binding: 0, resource: { buffer: uniSlot.buffer, offset: uniSlot.offset, size: BMASK_COMBINE_UNIFORM_SIZE } },
          { binding: 1, resource: texture.view },
          { binding: 2, resource: prevAccView },
          { binding: 3, resource: dest.createView() },
        ],
      });

      const pass = encoder.beginComputePass({
        label: `Bmask Combine Pass (${layerId} #${i})`,
        timestampWrites: ctx.gpuTimer?.pass('bmaskCombine'),
      });
      pass.setPipeline(pipelineCache.getBmaskCombinePipeline());
      // Static uniform binding (offset baked into the bind group's resource.offset
      // above), so NO dynamic offset array here — same posture as the vmask fill.
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(outW / BMASK_COMBINE_WORKGROUP_SIZE),
        Math.ceil(outH / BMASK_COMBINE_WORKGROUP_SIZE),
      );
      pass.end();
    }
  }

  private wrap(entry: BmaskCombineCacheEntry): LayerTexture {
    // Exact-size owned texture ⇒ allocated == content ⇒ maxU=maxV=1.
    return new LayerTexture({
      texture: entry.output,
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
        entry.output.destroy();
        entry.ping.destroy();
        entry.pong.destroy();
        this.entries.delete(id);
      }
    }
  }

  /** Teardown seam — destroy all textures + the private ring (WebGpuEngine.destroy()). */
  clear(): void {
    this.disposeTextures();
    this.uniformRing?.destroy();
    this.uniformRing = null;
    this.device = null;
  }
}

const cache = new BmaskCombineCache();

/**
 * Combine every layer's enabled bmask records into an owned coverage texture,
 * recorded onto `encoder` BEFORE the composite render passes open, and populate
 * `out` keyed by layer id. Layers without a bmask desc (or with no resolved
 * record) get no entry → the compositor leaves them unmasked. Sweeps entries
 * whose layer vanished.
 */
export function prepareBmaskCombineSources(
  encoder: GPUCommandEncoder,
  compiled: CompiledScene,
  ctx: BuildContext,
  out: Map<string, LayerTexture>,
): void {
  const seen = new Set<string>();
  for (const layer of compiled.scene.layers) {
    const bmask = layer.bmask;
    if (!bmask || bmask.records.length === 0) continue;
    const combined = cache.prepare(encoder, ctx, layer.id, bmask.records);
    if (!combined) continue;
    out.set(layer.id, combined);
    seen.add(layer.id);
  }
  cache.sweep(seen);
}

/**
 * Release all owned combined bmask textures + the private uniform ring. Call on
 * engine teardown (WebGpuEngine.destroy()) beside `clearVmaskCache()`.
 */
export function clearBmaskCombineCache(): void {
  cache.clear();
}
