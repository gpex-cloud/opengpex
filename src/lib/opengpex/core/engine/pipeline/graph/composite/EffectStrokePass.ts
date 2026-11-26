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
 * EffectStrokePass.ts — The stroke effect's compute pipeline (G1):
 * dual-field 1+JFA signed Euclidean distance transform (`shaders/edtJfa`)
 * followed by pointwise three-mode threshold compose (`shaders/strokeCompose`).
 *
 * Cross-frame EDT cache (`EdtCache`): the dual-field seed map depends ONLY on
 * the content alpha silhouette and window geometry, NOT on stroke colour,
 * stroke width (when the window matches), or position mode — so edits to
 * colour/position reuse the cached `rgba16uint` seed map with zero JFA passes.
 *
 * @module core/gpu/graph/composite/EffectStrokePass
 */

import { LayerTexture } from '@opengpex/editor/core/engine/gpu/resources/LayerTexture';
import { GPUTextureUsage } from '@opengpex/editor/core/engine/gpu/constants';
import {
  EDT_WORKGROUP_SIZE,
  EDT_SEED_UNIFORM_BUFFER_SIZE,
  EDT_JFA_UNIFORM_BUFFER_SIZE,
  jfaStepSequence,
  packEdtSeedUniform,
  packEdtJfaUniform,
} from '@opengpex/editor/core/engine/gpu/shaders/edtJfa';
import {
  packStrokeComposeUniform,
  STROKE_COMPOSE_UNIFORM_BUFFER_SIZE,
  STROKE_COMPOSE_WORKGROUP,
} from '@opengpex/editor/core/engine/gpu/shaders/strokeCompose';
import type { StrokePosition } from '@opengpex/editor/core/types/models';
import { acquireEffectOutputTransient, type FilterPassContext } from './FilterPass';

interface TexelRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const EDT_TRANSIENT_USAGE =
  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;

interface EdtCacheEntry {
  key: string;
  texture: LayerTexture;
  gpuTexture: GPUTexture;
}

class EdtCache {
  private device: GPUDevice | null = null;
  private readonly entries = new Map<string, EdtCacheEntry>();

  private ensureDevice(device: GPUDevice): void {
    if (this.device !== device) {
      this.clear();
      this.device = device;
    }
  }

  get(device: GPUDevice, cacheId: string, key: string): LayerTexture | undefined {
    this.ensureDevice(device);
    const entry = this.entries.get(cacheId);
    return entry && entry.key === key ? entry.texture : undefined;
  }

  set(device: GPUDevice, cacheId: string, key: string, gpuTexture: GPUTexture, width: number, height: number): LayerTexture {
    this.ensureDevice(device);
    const prev = this.entries.get(cacheId);
    if (prev) prev.gpuTexture.destroy();
    const wrapped = new LayerTexture({
      texture: gpuTexture,
      width,
      height,
      allocatedWidth: width,
      allocatedHeight: height,
      format: 'rgba16uint',
    });
    this.entries.set(cacheId, { key, texture: wrapped, gpuTexture });
    return wrapped;
  }

  sweep(activeIds: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) {
      if (!activeIds.has(id)) {
        entry.gpuTexture.destroy();
        this.entries.delete(id);
      }
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.gpuTexture.destroy();
    this.entries.clear();
  }
}

const edtCache = new EdtCache();

/** Release all owned dual-field EDT textures (wire into `WebGpuEngine.destroy()`). */
export function clearEdtCache(): void {
  edtCache.clear();
}

/** Sweep cached EDT textures for layers no longer carrying effects. */
export function sweepEdtCache(activeKeys: ReadonlySet<string>): void {
  edtCache.sweep(activeKeys);
}

export class EffectStrokePass {
  /**
   * The shared dual-field 1+JFA EDT: seed the content silhouette inside the
   * window, then flood. Used by the stroke compose AND (P5) by the shadow's
   * spread stage — one distance field, two consumers.
   */
  static computeEdt(
    encoder: GPUCommandEncoder,
    ctx: FilterPassContext,
    p: {
      readonly layerId: string;
      /** Cache slot id (per consumer — stroke instances and shadow spreads differ). */
      readonly cacheId: string;
      readonly content: LayerTexture;
      readonly windowTexel: TexelRect;
      readonly contentVisibleTexel?: TexelRect;
      /** Alpha-only cache key for cross-frame EDT reuse. */
      readonly edtAlphaKey?: string;
    },
  ): LayerTexture {
    const width = Math.max(1, p.windowTexel.w);
    const height = Math.max(1, p.windowTexel.h);
    const cacheId = p.cacheId;
    const vis = p.contentVisibleTexel;
    const visKey = vis ? `${Math.floor(vis.x)},${Math.floor(vis.y)},${Math.ceil(vis.w)},${Math.ceil(vis.h)}` : 'full';
    const fullEdtKey = p.edtAlphaKey
      ? `${p.edtAlphaKey}|win:${p.windowTexel.x},${p.windowTexel.y},${width},${height}|vis:${visKey}`
      : undefined;

    let edtResult = fullEdtKey ? edtCache.get(ctx.device, cacheId, fullEdtKey) : undefined;
    if (!edtResult) {
      const steps = jfaStepSequence(width, height);
      const pingGpu = ctx.device.createTexture({
        size: { width, height },
        format: 'rgba16uint',
        usage: EDT_TRANSIENT_USAGE,
        label: `EDT Ping (${p.layerId})`,
      });
      const pongGpu = ctx.device.createTexture({
        size: { width, height },
        format: 'rgba16uint',
        usage: EDT_TRANSIENT_USAGE,
        label: `EDT Pong (${p.layerId})`,
      });
      const ping = new LayerTexture({
        texture: pingGpu,
        width,
        height,
        allocatedWidth: width,
        allocatedHeight: height,
        format: 'rgba16uint',
      });
      const pong = new LayerTexture({
        texture: pongGpu,
        width,
        height,
        allocatedWidth: width,
        allocatedHeight: height,
        format: 'rgba16uint',
      });

      const contentSampleType = ctx.workingFormat === 'rgba32float' ? 'unfilterable-float' : 'float';
      const seedUniform = packEdtSeedUniform(width, height, {
        width: p.content.width,
        height: p.content.height,
        originX: p.windowTexel.x,
        originY: p.windowTexel.y,
        visibleRect: p.contentVisibleTexel,
      });
      const seedSlot = ctx.bufferRing.writeSlot(seedUniform);
      const seedBg = ctx.device.createBindGroup({
        layout: ctx.pipelineCache.getEdtSeedBindGroupLayout(contentSampleType),
        label: `EDT Seed BindGroup (${p.layerId})`,
        entries: [
          {
            binding: 0,
            resource: { buffer: ctx.bufferRing.getBuffer(), offset: 0, size: EDT_SEED_UNIFORM_BUFFER_SIZE },
          },
          { binding: 1, resource: p.content.view },
          { binding: 2, resource: ping.view },
        ],
      });
      const wgX = Math.ceil(width / EDT_WORKGROUP_SIZE);
      const wgY = Math.ceil(height / EDT_WORKGROUP_SIZE);
      const seedPass = encoder.beginComputePass({ label: `EDT Seed (${p.layerId})` });
      seedPass.setPipeline(ctx.pipelineCache.getEdtSeedPipeline(contentSampleType));
      seedPass.setBindGroup(0, seedBg, [seedSlot.offset]);
      seedPass.dispatchWorkgroups(wgX, wgY, 1);
      seedPass.end();

      let srcTex = ping;
      let dstTex = pong;
      let srcGpu = pingGpu;
      let dstGpu = pongGpu;
      const jfaLayout = ctx.pipelineCache.getEdtJfaBindGroupLayout();
      const jfaPipeline = ctx.pipelineCache.getEdtJfaPipeline();
      for (const step of steps) {
        const jfaUniform = packEdtJfaUniform(width, height, step);
        const jfaSlot = ctx.bufferRing.writeSlot(jfaUniform);
        const jfaBg = ctx.device.createBindGroup({
          layout: jfaLayout,
          label: `EDT JFA s=${step} (${p.layerId})`,
          entries: [
            {
              binding: 0,
              resource: { buffer: ctx.bufferRing.getBuffer(), offset: 0, size: EDT_JFA_UNIFORM_BUFFER_SIZE },
            },
            { binding: 1, resource: srcTex.view },
            { binding: 2, resource: dstTex.view },
          ],
        });
        const jfaPass = encoder.beginComputePass({ label: `EDT JFA s=${step} (${p.layerId})` });
        jfaPass.setPipeline(jfaPipeline);
        jfaPass.setBindGroup(0, jfaBg, [jfaSlot.offset]);
        jfaPass.dispatchWorkgroups(wgX, wgY, 1);
        jfaPass.end();
        const tmpTex = srcTex; srcTex = dstTex; dstTex = tmpTex;
        const tmpGpu = srcGpu; srcGpu = dstGpu; dstGpu = tmpGpu;
      }

      // Discard the unused ping-pong buffer via scratch after submit; keep the
      // winning buffer in EdtCache when a key is provided (else scratch both).
      ctx.scratch.push(dstGpu);
      if (fullEdtKey) {
        edtResult = edtCache.set(ctx.device, cacheId, fullEdtKey, srcGpu, width, height);
      } else {
        ctx.scratch.push(srcGpu);
        edtResult = srcTex;
      }
    }
    return edtResult;
  }

  static run(
    encoder: GPUCommandEncoder,
    ctx: FilterPassContext,
    p: {
      readonly layerId: string;
      readonly instanceIndex: number;
      readonly content: LayerTexture;
      readonly windowTexel: TexelRect;
      readonly contentIsLinear: boolean;
      readonly gamutId: number;
      readonly strokeColor: readonly [number, number, number, number];
      readonly widthTexels: number;
      readonly position: StrokePosition;
      readonly contentVisibleTexel?: TexelRect;
      /** Alpha-only cache key for cross-frame EDT reuse. */
      readonly edtAlphaKey?: string;
    },
  ): LayerTexture {
    const width = Math.max(1, p.windowTexel.w);
    const height = Math.max(1, p.windowTexel.h);
    const edtResult = EffectStrokePass.computeEdt(encoder, ctx, {
      layerId: p.layerId,
      cacheId: `${p.layerId}#${p.instanceIndex}`,
      content: p.content,
      windowTexel: p.windowTexel,
      contentVisibleTexel: p.contentVisibleTexel,
      edtAlphaKey: p.edtAlphaKey,
    });

    const out = acquireEffectOutputTransient(ctx, p.layerId, 'stroke', width, height);
    const uniform = packStrokeComposeUniform(width, height, {
      contentIsLinear: p.contentIsLinear,
      gamutId: p.gamutId,
      contentWidth: p.content.width,
      contentHeight: p.content.height,
      contentOriginX: -p.windowTexel.x,
      contentOriginY: -p.windowTexel.y,
      strokeColor: p.strokeColor,
      contentDensity: 1,
      windowDensity: 1,
      strokeWidthTexels: p.widthTexels,
      strokePosition: p.position,
      contentVisible: p.contentVisibleTexel,
    });
    const slot = ctx.bufferRing.writeSlot(uniform);
    const bindGroup = ctx.device.createBindGroup({
      layout: ctx.pipelineCache.getStrokeComposeBindGroupLayout(ctx.workingFormat),
      label: `Stroke Compose BindGroup (${p.layerId})`,
      entries: [
        {
          binding: 0,
          resource: { buffer: ctx.bufferRing.getBuffer(), offset: 0, size: STROKE_COMPOSE_UNIFORM_BUFFER_SIZE },
        },
        { binding: 1, resource: edtResult.view },
        { binding: 2, resource: p.content.view },
        { binding: 3, resource: out.view },
      ],
    });
    const pass = encoder.beginComputePass({ label: `Stroke Compose (${p.layerId})` });
    pass.setPipeline(ctx.pipelineCache.getStrokeComposePipeline(ctx.workingFormat));
    pass.setBindGroup(0, bindGroup, [slot.offset]);
    pass.dispatchWorkgroups(
      Math.ceil(width / STROKE_COMPOSE_WORKGROUP),
      Math.ceil(height / STROKE_COMPOSE_WORKGROUP),
      1,
    );
    pass.end();
    return out;
  }

}
