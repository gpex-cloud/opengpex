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
import { BLEND_MODE_MAP, isHardwareBlendable, BLEND_WGSL } from '../../shaders/blend';
import { BlendPass, type BlendPassContext, type DrawBlendParams } from './BlendPass';
import { MAT3_IDENTITY, type LayerNode } from '../../scene/Scene';
import type { LayerTexture } from '../../resources/LayerTexture';
import type { PipelineCache } from '../../resources/PipelineCache';
import type { BufferRing } from '../../resources/BufferRing';

describe('Blend Mode Constants & Classifications', () => {
  it('defines exactly 16 blend modes', () => {
    const keys = Object.keys(BLEND_MODE_MAP);
    expect(keys.length).toBe(16);
    expect(BLEND_MODE_MAP['source-over']).toBe(0);
    expect(BLEND_MODE_MAP['multiply']).toBe(1);
    expect(BLEND_MODE_MAP['screen']).toBe(2);
    expect(BLEND_MODE_MAP['overlay']).toBe(3);
    expect(BLEND_MODE_MAP['darken']).toBe(4);
    expect(BLEND_MODE_MAP['lighten']).toBe(5);
    expect(BLEND_MODE_MAP['color-dodge']).toBe(6);
    expect(BLEND_MODE_MAP['color-burn']).toBe(7);
    expect(BLEND_MODE_MAP['hard-light']).toBe(8);
    expect(BLEND_MODE_MAP['soft-light']).toBe(9);
    expect(BLEND_MODE_MAP['difference']).toBe(10);
    expect(BLEND_MODE_MAP['exclusion']).toBe(11);
    expect(BLEND_MODE_MAP['hue']).toBe(12);
    expect(BLEND_MODE_MAP['saturation']).toBe(13);
    expect(BLEND_MODE_MAP['color']).toBe(14);
    expect(BLEND_MODE_MAP['luminosity']).toBe(15);
  });

  it('classifies only source-over as hardware-blendable (class A); all others class B', () => {
    // Class A — only Normal/source-over (core §7.2; enum has no Add).
    expect(isHardwareBlendable('source-over')).toBe(true);

    // Class B — W3C-separable but NOT hardware-expressible under premultiplied
    // alpha (the P0 red line: these silently degraded to Normal before WP-0).
    expect(isHardwareBlendable('multiply')).toBe(false);
    expect(isHardwareBlendable('screen')).toBe(false);
    expect(isHardwareBlendable('darken')).toBe(false);
    expect(isHardwareBlendable('lighten')).toBe(false);

    // Class B — non-separable / needs background sampling.
    expect(isHardwareBlendable('overlay')).toBe(false);
    expect(isHardwareBlendable('color-dodge')).toBe(false);
    expect(isHardwareBlendable('color-burn')).toBe(false);
    expect(isHardwareBlendable('hard-light')).toBe(false);
    expect(isHardwareBlendable('soft-light')).toBe(false);
    expect(isHardwareBlendable('difference')).toBe(false);
    expect(isHardwareBlendable('exclusion')).toBe(false);
    expect(isHardwareBlendable('hue')).toBe(false);
    expect(isHardwareBlendable('saturation')).toBe(false);
    expect(isHardwareBlendable('color')).toBe(false);
    expect(isHardwareBlendable('luminosity')).toBe(false);
  });

  it('contains all 16 mode branches in BLEND_WGSL', () => {
    expect(BLEND_WGSL).toContain('case 0u:');
    expect(BLEND_WGSL).toContain('case 1u:');
    expect(BLEND_WGSL).toContain('case 2u:');
    expect(BLEND_WGSL).toContain('case 3u:');
    expect(BLEND_WGSL).toContain('case 4u:');
    expect(BLEND_WGSL).toContain('case 5u:');
    expect(BLEND_WGSL).toContain('case 6u:');
    expect(BLEND_WGSL).toContain('case 7u:');
    expect(BLEND_WGSL).toContain('case 8u:');
    expect(BLEND_WGSL).toContain('case 9u:');
    expect(BLEND_WGSL).toContain('case 10u:');
    expect(BLEND_WGSL).toContain('case 11u:');
    expect(BLEND_WGSL).toContain('case 12u:');
    expect(BLEND_WGSL).toContain('case 13u:');
    expect(BLEND_WGSL).toContain('case 14u:');
    expect(BLEND_WGSL).toContain('case 15u:');
  });
});

describe('BlendPass Execution', () => {
  it('binds resources and issues a 6-vertex quad draw call', () => {
    const setPipeline = vi.fn();
    const setVertexBuffer = vi.fn();
    const setBindGroup = vi.fn();
    const draw = vi.fn();

    const mockPassEncoder = {
      setPipeline,
      setVertexBuffer,
      setBindGroup,
      draw,
    } as unknown as GPURenderPassEncoder;

    const mockBindGroupLayout = {} as GPUBindGroupLayout;
    const mockPipeline = {} as GPURenderPipeline;
    const mockQuadBuffer = {} as GPUBuffer;
    const mockSampler = {} as GPUSampler;
    const mockDummyMaskView = {} as GPUTextureView;

    const mockPipelineCache = {
      getBlendBindGroupLayout: vi.fn().mockReturnValue(mockBindGroupLayout),
      getBlendPipeline: vi.fn().mockReturnValue(mockPipeline),
      getQuadVertexBuffer: vi.fn().mockReturnValue(mockQuadBuffer),
      getLinearSampler: vi.fn().mockReturnValue(mockSampler),
      getNearestSampler: vi.fn().mockReturnValue(mockSampler),
      getSamplerForScale: vi.fn().mockReturnValue(mockSampler),
      getDefaultMaskView: vi.fn().mockReturnValue(mockDummyMaskView),
    } as unknown as PipelineCache;

    let capturedData: Float32Array | null = null;
    const mockBufferRing = {
      writeSlot: vi.fn().mockImplementation((data: Float32Array) => {
        capturedData = new Float32Array(data);
        return { offset: 256, size: 80 };
      }),
      getBuffer: vi.fn().mockReturnValue({} as GPUBuffer),
    } as unknown as BufferRing;

    const createBindGroup = vi.fn().mockReturnValue({} as GPUBindGroup);
    const mockDevice = {
      createBindGroup,
    } as unknown as GPUDevice;

    const ctx: BlendPassContext = {
      device: mockDevice,
      pipelineCache: mockPipelineCache,
      bufferRing: mockBufferRing,
      frameWidth: 800,
      frameHeight: 600,
      targetFormat: 'rgba16float',
      channelMask: 'rgb',
    };

    const mockFgView = {} as GPUTextureView;
    const mockBgView = {} as GPUTextureView;

    const fgTexture = {
      width: 400,
      height: 300,
      texture: { createView: vi.fn().mockReturnValue(mockFgView) } as unknown as GPUTexture,
    } as unknown as LayerTexture;

    const bgTexture = {
      width: 800,
      height: 600,
      texture: { createView: vi.fn().mockReturnValue(mockBgView) } as unknown as GPUTexture,
    } as unknown as LayerTexture;

    const layer: LayerNode = {
      id: 'layer-overlay',
      source: { kind: 'raster', assetId: 'asset-1' },
      transform: MAT3_IDENTITY,
      opacity: 0.75,
      blendMode: 'overlay',
    };

    const params: DrawBlendParams = {
      layer,
      fgTexture,
      bgTexture,
    };

    BlendPass.drawLayer(mockPassEncoder, ctx, params);

    expect(mockBufferRing.writeSlot).toHaveBeenCalled();
    expect(capturedData).not.toBeNull();
    const uintView = new Uint32Array(capturedData!.buffer);
    expect(uintView[17]).toBe(3); // overlay mode is 3
    expect(capturedData![16]).toBeCloseTo(0.75); // opacity
    expect(createBindGroup).toHaveBeenCalled();
    expect(setPipeline).toHaveBeenCalledWith(mockPipeline);
    expect(setVertexBuffer).toHaveBeenCalledWith(0, mockQuadBuffer);
    expect(setBindGroup).toHaveBeenCalledWith(0, expect.anything(), [256]);
    expect(draw).toHaveBeenCalledWith(6, 1, 0, 0);
  });

  it('packs fg_frame_to_local as the inverse placement so a full-frame quad recovers foreground coverage (§7.5)', () => {
    // Regression: the ping-pong blend pass previously drew only a layer-sized
    // quad, so a loadOp:'clear' scratch stayed transparent everywhere the layer
    // did not cover and the background was erased on any non-separable mode. The
    // fix draws a FULL-FRAME quad and maps each frame pixel back into
    // foreground-local unit coords via `fg_frame_to_local` (slots 0..11). This
    // test asserts that inverse matrix takes the layer's frame-space rect corners
    // to local (0,0) and (1,1); anything outside → local outside 0..1 → the
    // shader treats it as no-coverage and passes the background through.
    let capturedData: Float32Array | null = null;
    const mockBufferRing = {
      writeSlot: vi.fn().mockImplementation((data: Float32Array) => {
        capturedData = new Float32Array(data);
        return { offset: 0, size: 80 };
      }),
      getBuffer: vi.fn().mockReturnValue({} as GPUBuffer),
    } as unknown as BufferRing;

    const mockPipelineCache = {
      getBlendBindGroupLayout: vi.fn().mockReturnValue({}),
      getBlendPipeline: vi.fn().mockReturnValue({}),
      getQuadVertexBuffer: vi.fn().mockReturnValue({}),
      getLinearSampler: vi.fn().mockReturnValue({}),
      getNearestSampler: vi.fn().mockReturnValue({}),
      getSamplerForScale: vi.fn().mockReturnValue({}),
      getDefaultMaskView: vi.fn().mockReturnValue({}),
    } as unknown as PipelineCache;

    const mockDevice = {
      createBindGroup: vi.fn().mockReturnValue({}),
    } as unknown as GPUDevice;

    const passEncoder = {
      setPipeline: vi.fn(),
      setVertexBuffer: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
    } as unknown as GPURenderPassEncoder;

    const ctx: BlendPassContext = {
      device: mockDevice,
      pipelineCache: mockPipelineCache,
      bufferRing: mockBufferRing,
      frameWidth: 800,
      frameHeight: 600,
      targetFormat: 'rgba16float',
      channelMask: 'rgb',
    };

    // 400x300 texture, cropped to a 200x150 sub-rect at (100,50); identity
    // transform → the layer occupies frame-space x∈[100,300], y∈[50,200].
    const fgTexture = {
      width: 400,
      height: 300,
      texture: { createView: vi.fn().mockReturnValue({}) } as unknown as GPUTexture,
    } as unknown as LayerTexture;
    const bgTexture = {
      width: 800,
      height: 600,
      texture: { createView: vi.fn().mockReturnValue({}) } as unknown as GPUTexture,
    } as unknown as LayerTexture;

    const layer: LayerNode = {
      id: 'cropped-multiply',
      source: { kind: 'raster', assetId: 'asset-1' },
      transform: MAT3_IDENTITY,
      opacity: 1,
      blendMode: 'multiply',
      crop: { x: 100, y: 50, w: 200, h: 150 },
    };

    BlendPass.drawLayer(passEncoder, ctx, { layer, fgTexture, bgTexture });

    expect(capturedData).not.toBeNull();
    const d = capturedData!;
    // Column-major mat3x3 (16-byte padded columns): recover the affine.
    const m = {
      a: d[0],
      b: d[1],
      c: d[4],
      d: d[5],
      tx: d[8],
      ty: d[9],
    };
    const apply = (x: number, y: number): [number, number] => [
      m.a * x + m.c * y + m.tx,
      m.b * x + m.d * y + m.ty,
    ];

    // Frame-space rect corners map to the local unit square.
    const topLeft = apply(100, 50);
    const bottomRight = apply(300, 200);
    expect(topLeft[0]).toBeCloseTo(0, 5);
    expect(topLeft[1]).toBeCloseTo(0, 5);
    expect(bottomRight[0]).toBeCloseTo(1, 5);
    expect(bottomRight[1]).toBeCloseTo(1, 5);

    // A frame pixel well outside the layer rect maps outside 0..1 (no coverage,
    // background preserved). The frame origin (0,0) is above-left of the rect.
    const outside = apply(0, 0);
    const outOfRange =
      outside[0] < 0 || outside[0] > 1 || outside[1] < 0 || outside[1] > 1;
    expect(outOfRange).toBe(true);
  });
});
