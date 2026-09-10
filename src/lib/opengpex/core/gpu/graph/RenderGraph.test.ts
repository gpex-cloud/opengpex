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

import { describe, it, expect, vi } from 'vitest';
import { RenderGraph, type RenderGraphContext } from './RenderGraph';
import { SceneCompiler } from './SceneCompiler';
import { EMPTY_SCENE, MAT3_IDENTITY, type Scene, type LayerNode } from '../scene/Scene';
import type { LayerTexture } from '../resources/LayerTexture';
import type { PipelineCache } from '../resources/PipelineCache';
import type { BufferRing } from '../resources/BufferRing';
import type { TexturePool } from '../resources/TexturePool';

function makeLayer(id: string, blendMode: LayerNode['blendMode']): LayerNode {
  return {
    id,
    source: { kind: 'raster', assetId: `asset-${id}` },
    transform: MAT3_IDENTITY,
    opacity: 1.0,
    blendMode,
  };
}

describe('RenderGraph Execution', () => {
  it('pure-separable path composites offscreen then presents via the view pass (缺陷 5 §5)', () => {
    const scene: Scene = {
      ...EMPTY_SCENE,
      frame: { width: 1000, height: 800 },
      layers: [
        makeLayer('l1', 'source-over'),
        makeLayer('l2', 'source-over'),
      ],
    };

    const compiled = SceneCompiler.compile(scene);
    expect(compiled.isPureDirect).toBe(true);

    const setViewport = vi.fn();
    const beginRenderPass = vi.fn().mockReturnValue({
      setViewport,
      setPipeline: vi.fn(),
      setVertexBuffer: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
      end: vi.fn(),
    });

    const finish = vi.fn().mockReturnValue({} as GPUCommandBuffer);
    const createCommandEncoder = vi.fn().mockReturnValue({
      beginRenderPass,
      finish,
    });

    const submit = vi.fn();
    const mockDevice = {
      createCommandEncoder,
      createBindGroup: vi.fn().mockReturnValue({}),
      queue: { submit },
    } as unknown as GPUDevice;

    const rawTarget = {
      width: 1024,
      height: 1024,
      createView: vi.fn().mockReturnValue({}),
      destroy: vi.fn(),
    } as unknown as GPUTexture;
    const acquire = vi.fn().mockReturnValue(rawTarget);
    const release = vi.fn();
    const mockTexturePool = {
      acquire,
      release,
    } as unknown as TexturePool;

    const mockBufferRing = {
      allocate: vi.fn().mockReturnValue({
        offset: 0,
        size: 64,
      }),
      writeSlot: vi.fn().mockReturnValue({
        offset: 0,
        size: 64,
      }),
      getBuffer: vi.fn().mockReturnValue({}),
    } as unknown as BufferRing;

    const mockPipelineCache = {
      getLayerPipelineLayout: vi.fn().mockReturnValue({}),
      getLayerBindGroupLayout: vi.fn().mockReturnValue({}),
      getLayerPipeline: vi.fn().mockReturnValue({}),
      getViewBindGroupLayout: vi.fn().mockReturnValue({}),
      getViewPipeline: vi.fn().mockReturnValue({}),
      getQuadVertexBuffer: vi.fn().mockReturnValue({}),
      getLinearSampler: vi.fn().mockReturnValue({}),
      getNearestSampler: vi.fn().mockReturnValue({}),
      getSamplerForScale: vi.fn().mockReturnValue({}),
      getDefaultMaskView: vi.fn().mockReturnValue({}),
    } as unknown as PipelineCache;

    const mockTexture = {
      createView: vi.fn().mockReturnValue({}),
    } as unknown as GPUTexture;

    const asset1 = { width: 500, height: 400, texture: mockTexture } as unknown as LayerTexture;
    const asset2 = { width: 500, height: 400, texture: mockTexture } as unknown as LayerTexture;
    const assets = new Map<string, LayerTexture>([
      ['asset-l1', asset1],
      ['asset-l2', asset2],
    ]);

    const currentView = {} as GPUTextureView;

    const ctx: RenderGraphContext = {
      device: mockDevice,
      pipelineCache: mockPipelineCache,
      bufferRing: mockBufferRing,
      texturePool: mockTexturePool,
      assets,
      currentView,
      targetFormat: 'bgra8unorm',
    };

    RenderGraph.execute(compiled, ctx);

    // 缺陷 5 §5 阶段 2: `execute` (non-caching orchestrator) composites into ONE
    // offscreen document texture, presents it via the view pass, then releases
    // the composite target back to the pool.
    expect(acquire).toHaveBeenCalledTimes(1);
    // The composite pass constrains NDC to the frame-sized top-left of the bucket.
    expect(setViewport).toHaveBeenCalledWith(0, 0, 1000, 800, 0, 1);
    // The view pass is presented via the dedicated view pipeline.
    expect(mockPipelineCache.getViewPipeline).toHaveBeenCalledWith('bgra8unorm');
    // Two command buffers: one for compositing, one for presenting.
    expect(createCommandEncoder).toHaveBeenCalledWith({ label: 'RenderGraph Composite Encoder' });
    expect(createCommandEncoder).toHaveBeenCalledWith({ label: 'RenderGraph Present Encoder' });
    expect(submit).toHaveBeenCalledTimes(2);
    // The composite target is returned to the pool by the non-caching orchestrator.
    expect(release).toHaveBeenCalledWith(rawTarget);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('allocates transient textures and executes ping-pong passes when non-separable layers exist', () => {
    const scene: Scene = {
      ...EMPTY_SCENE,
      frame: { width: 800, height: 600 },
      layers: [
        makeLayer('l1', 'source-over'),
        makeLayer('l2', 'overlay'), // non-separable triggers ping-pong
      ],
    };

    const compiled = SceneCompiler.compile(scene);
    expect(compiled.isPureDirect).toBe(false);

    const setViewport = vi.fn();
    const beginRenderPass = vi.fn().mockReturnValue({
      setViewport,
      setPipeline: vi.fn(),
      setVertexBuffer: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
      end: vi.fn(),
    });

    const copyTextureToTexture = vi.fn();
    const finish = vi.fn().mockReturnValue({} as GPUCommandBuffer);
    const createCommandEncoder = vi.fn().mockReturnValue({
      beginRenderPass,
      copyTextureToTexture,
      finish,
    });

    const submit = vi.fn();
    const mockDevice = {
      createCommandEncoder,
      createBindGroup: vi.fn().mockReturnValue({}),
      queue: { submit },
    } as unknown as GPUDevice;

    const rawTargetA = {
      width: 1024,
      height: 1024,
      createView: vi.fn().mockReturnValue({}),
      destroy: vi.fn(),
    } as unknown as GPUTexture;

    const rawTargetB = {
      width: 1024,
      height: 1024,
      createView: vi.fn().mockReturnValue({}),
      destroy: vi.fn(),
    } as unknown as GPUTexture;

    const acquire = vi.fn().mockReturnValueOnce(rawTargetA).mockReturnValueOnce(rawTargetB);
    const release = vi.fn();
    const mockTexturePool = {
      acquire,
      release,
    } as unknown as TexturePool;

    const mockBufferRing = {
      allocate: vi.fn().mockReturnValue({
        offset: 0,
        size: 64,
      }),
      writeSlot: vi.fn().mockReturnValue({
        offset: 0,
        size: 64,
      }),
      getBuffer: vi.fn().mockReturnValue({}),
    } as unknown as BufferRing;

    const mockPipelineCache = {
      getLayerPipelineLayout: vi.fn().mockReturnValue({}),
      getLayerBindGroupLayout: vi.fn().mockReturnValue({}),
      getLayerPipeline: vi.fn().mockReturnValue({}),
      getBlendPipelineLayout: vi.fn().mockReturnValue({}),
      getBlendBindGroupLayout: vi.fn().mockReturnValue({}),
      getBlendPipeline: vi.fn().mockReturnValue({}),
      getViewBindGroupLayout: vi.fn().mockReturnValue({}),
      getViewPipeline: vi.fn().mockReturnValue({}),
      getQuadVertexBuffer: vi.fn().mockReturnValue({}),
      getLinearSampler: vi.fn().mockReturnValue({}),
      getNearestSampler: vi.fn().mockReturnValue({}),
      getSamplerForScale: vi.fn().mockReturnValue({}),
      getDefaultMaskView: vi.fn().mockReturnValue({}),
    } as unknown as PipelineCache;

    const mockAssetTex = {
      createView: vi.fn().mockReturnValue({}),
    } as unknown as GPUTexture;

    const asset1 = { width: 800, height: 600, texture: mockAssetTex } as unknown as LayerTexture;
    const asset2 = { width: 400, height: 300, texture: mockAssetTex } as unknown as LayerTexture;
    const assets = new Map<string, LayerTexture>([
      ['asset-l1', asset1],
      ['asset-l2', asset2],
    ]);

    const currentView = {} as GPUTextureView;

    const ctx: RenderGraphContext = {
      device: mockDevice,
      pipelineCache: mockPipelineCache,
      bufferRing: mockBufferRing,
      texturePool: mockTexturePool,
      assets,
      currentView,
      targetFormat: 'bgra8unorm',
      workingFormat: 'rgba16float',
    };

    RenderGraph.execute(compiled, ctx);

    // Must acquire 2 transient textures for ping-pong
    expect(acquire).toHaveBeenCalledTimes(2);

    // §7.5 / ping-pong viewport fix: the transient targets are oversized buckets
    // (POT-snapped, larger than the frame). Each drawing pass MUST constrain NDC to
    // the frame-sized top-left region via setViewport, otherwise layers stretch to
    // fill the whole bucket and the final blit (which samples frame/bucket UV) shows
    // a scaled/misplaced result with the main image pushed off-screen.
    expect(setViewport).toHaveBeenCalledWith(0, 0, 800, 600, 0, 1);

    // WP-2 / §7.5: ping-pong must NOT do a full-canvas copyTextureToTexture.
    // BlendPass reads the accumulator via bound bg_tex and writes to scratch with
    // loadOp:'clear', so the copy is a pure waste (66MB/layer DMA at 4K) — gone.
    expect(copyTextureToTexture).not.toHaveBeenCalled();

    // Must submit the ping-pong command buffer
    expect(submit).toHaveBeenCalledWith([expect.anything()]);

    // Must return both transient textures to TexturePool
    expect(release).toHaveBeenCalledWith(rawTargetA);
    expect(release).toHaveBeenCalledWith(rawTargetB);
    expect(release).toHaveBeenCalledTimes(2);
  });
});
