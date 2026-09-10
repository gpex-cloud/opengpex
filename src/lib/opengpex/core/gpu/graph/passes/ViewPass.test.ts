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
 * ViewPass.test.ts — 缺陷 5 §5 view pass (supersedes the old BlitPass).
 *
 * ViewPass must drive its own dedicated pipeline (setPipeline + setBindGroup +
 * draw(6)), pack the view matrix column-major into the uniform, scale UV by the
 * source content fraction (maxU/maxV), and write the channel mask.
 */

import { describe, it, expect, vi } from 'vitest';
import { ViewPass, IDENTITY_VIEW_MATRIX, composeViewMatrix, type ViewPassContext, type ViewMatrix } from './ViewPass';
import type { LayerTexture } from '../../resources/LayerTexture';
import { channelMaskToUniformValue } from '../../shaders/layer';

describe('ViewPass dedicated pipeline (缺陷 5 §5)', () => {
  function makeCtx(overrides?: Partial<ViewPassContext>) {
    const viewPipeline = { __view: true };
    const quadBuffer = { __quad: true };
    const sampler = { __samp: true };
    const nearestSampler = { __nearest: true };
    const linearSampler = { __linear: true };

    const setPipeline = vi.fn();
    const setVertexBuffer = vi.fn();
    const setBindGroup = vi.fn();
    const draw = vi.fn();
    const passEncoder = { setPipeline, setVertexBuffer, setBindGroup, draw } as unknown as GPURenderPassEncoder;

    const createBindGroup = vi.fn().mockReturnValue({ __bg: true });
    const writeSlot = vi.fn().mockReturnValue({ offset: 256, size: 64 });
    const getBuffer = vi.fn().mockReturnValue({ __ring: true });

    const ctx: ViewPassContext = {
      device: { createBindGroup } as unknown as GPUDevice,
      pipelineCache: {
        getViewPipeline: vi.fn().mockReturnValue(viewPipeline),
        getViewBindGroupLayout: vi.fn().mockReturnValue({ __viewBGL: true }),
        getLinearSampler: vi.fn().mockReturnValue(sampler),
        getNearestSampler: vi.fn().mockReturnValue(nearestSampler),
        // Mirror the real getSamplerForScale rule (≥1 → nearest, <1 → linear).
        getSamplerForScale: vi.fn().mockImplementation((s: number) => (s >= 1 ? nearestSampler : linearSampler)),
        getQuadVertexBuffer: vi.fn().mockReturnValue(quadBuffer),
      } as unknown as ViewPassContext['pipelineCache'],
      bufferRing: { writeSlot, getBuffer } as unknown as ViewPassContext['bufferRing'],
      targetFormat: 'bgra8unorm',
      channelMask: 'g',
      viewMatrix: IDENTITY_VIEW_MATRIX,
      ...overrides,
    };

    return { ctx, passEncoder, createBindGroup, writeSlot, setPipeline, setVertexBuffer, setBindGroup, draw, viewPipeline, quadBuffer, sampler, nearestSampler, linearSampler };
  }

  it('binds the view pipeline and draws a full-screen quad', () => {
    const t = makeCtx();
    const src = { view: { __srcView: true }, maxU: 1, maxV: 1 } as unknown as LayerTexture;

    ViewPass.draw(t.passEncoder, t.ctx, src);

    expect(t.ctx.pipelineCache.getViewPipeline).toHaveBeenCalledWith('bgra8unorm');
    expect(t.setPipeline).toHaveBeenCalledWith(t.viewPipeline);
    expect(t.setVertexBuffer).toHaveBeenCalledWith(0, t.quadBuffer);
    expect(t.setBindGroup).toHaveBeenCalledWith(0, { __bg: true }, [256]);
    expect(t.draw).toHaveBeenCalledWith(6);

    // Bind group wires the source texture view at binding 2.
    const bgDesc = t.createBindGroup.mock.calls[0][0];
    const texEntry = bgDesc.entries.find((e: { binding: number }) => e.binding === 2);
    expect(texEntry.resource).toBe(src.view);
  });

  it('packs the identity view matrix column-major and writes uv_scale + channel_mask', () => {
    const t = makeCtx();
    // Content fraction < 1 to prove maxU/maxV drive uv_scale (POT bucket).
    const src = { view: {}, maxU: 0.75, maxV: 0.5 } as unknown as LayerTexture;

    ViewPass.draw(t.passEncoder, t.ctx, src);

    const written = t.writeSlot.mock.calls[0][0] as Float32Array;
    const u32 = new Uint32Array(written.buffer);

    // Column-major mat3x3 (each column padded to vec4): col0=(a,b,0,_),
    // col1=(c,d,0,_), col2=(tx,ty,1,_). Identity = (2,0,0,-2,-1,1).
    expect(written[0]).toBeCloseTo(2, 6); // a
    expect(written[1]).toBeCloseTo(0, 6); // b
    expect(written[4]).toBeCloseTo(0, 6); // c
    expect(written[5]).toBeCloseTo(-2, 6); // d
    expect(written[8]).toBeCloseTo(-1, 6); // tx
    expect(written[9]).toBeCloseTo(1, 6); // ty
    expect(written[10]).toBeCloseTo(1, 6); // homogeneous 1

    // uv_scale at floats 12..13 = (maxU, maxV).
    expect(written[12]).toBeCloseTo(0.75, 6);
    expect(written[13]).toBeCloseTo(0.5, 6);

    // channel_mask u32 at slot 14 (g -> 2).
    expect(u32[14]).toBe(channelMaskToUniformValue('g'));
  });

  it('defaults channel mask to rgb (0) when unset', () => {
    const t = makeCtx({ channelMask: undefined });
    const src = { view: {}, maxU: 1, maxV: 1 } as unknown as LayerTexture;

    ViewPass.draw(t.passEncoder, t.ctx, src);

    const written = t.writeSlot.mock.calls[0][0] as Float32Array;
    const u32 = new Uint32Array(written.buffer);
    expect(u32[14]).toBe(channelMaskToUniformValue('rgb'));
  });

  // 缺陷 3 / §3 阶段 3a: the view pass is the correct home for the zoom sampler
  // choice after compose/view separation (layer.transform no longer carries the
  // camera). Both-way guard: zoomed-in → nearest, zoomed-out → linear.
  it('binds NEAREST sampler when zoomed in (sourceScale ≥ 1) — crisp pixels', () => {
    const t = makeCtx({ sourceScale: 8 });
    const src = { view: {}, maxU: 1, maxV: 1 } as unknown as LayerTexture;
    ViewPass.draw(t.passEncoder, t.ctx, src);
    const bg = t.createBindGroup.mock.calls[0][0];
    const sampEntry = bg.entries.find((e: { binding: number }) => e.binding === 1);
    expect(sampEntry.resource).toBe(t.nearestSampler);
  });

  it('binds LINEAR sampler when zoomed out (sourceScale < 1) — avoid moiré', () => {
    const t = makeCtx({ sourceScale: 0.25 });
    const src = { view: {}, maxU: 1, maxV: 1 } as unknown as LayerTexture;
    ViewPass.draw(t.passEncoder, t.ctx, src);
    const bg = t.createBindGroup.mock.calls[0][0];
    const sampEntry = bg.entries.find((e: { binding: number }) => e.binding === 1);
    expect(sampEntry.resource).toBe(t.linearSampler);
  });

  it('falls back to the linear sampler when sourceScale is unset', () => {
    const t = makeCtx({ sourceScale: undefined });
    const src = { view: {}, maxU: 1, maxV: 1 } as unknown as LayerTexture;
    ViewPass.draw(t.passEncoder, t.ctx, src);
    const bg = t.createBindGroup.mock.calls[0][0];
    const sampEntry = bg.entries.find((e: { binding: number }) => e.binding === 1);
    expect(sampEntry.resource).toBe(t.sampler); // getLinearSampler() marker
  });

  });

describe('composeViewMatrix (缺陷 5 §5 阶段 1b)', () => {
  const identityCamera: ViewMatrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

  it('SELF-CONSISTENCY: identity camera + doc==target reduces to IDENTITY_VIEW_MATRIX', () => {
    // This proves 阶段 1b is continuous with 阶段 1a: when the camera is identity
    // and the document exactly fills the target, the composed matrix must equal
    // the hard-coded 1:1 full-screen matrix used in 1a.
    const m = composeViewMatrix(identityCamera, 800, 600, 800, 600);
    expect(m.a).toBeCloseTo(IDENTITY_VIEW_MATRIX.a, 6);
    expect(m.b).toBeCloseTo(IDENTITY_VIEW_MATRIX.b, 6);
    expect(m.c).toBeCloseTo(IDENTITY_VIEW_MATRIX.c, 6);
    expect(m.d).toBeCloseTo(IDENTITY_VIEW_MATRIX.d, 6);
    expect(m.tx).toBeCloseTo(IDENTITY_VIEW_MATRIX.tx, 6);
    expect(m.ty).toBeCloseTo(IDENTITY_VIEW_MATRIX.ty, 6);
  });

  it('maps the document unit-quad corners to the correct NDC under a pan+zoom camera', () => {
    // Camera: scale 2 (renderScale) + translate (100, 50) physical px.
    // Document 400×300, target (swapchain) 1000×800.
    const camera: ViewMatrix = { a: 2, b: 0, c: 0, d: 2, tx: 100, ty: 50 };
    const docW = 400, docH = 300, tW = 1000, tH = 800;
    const m = composeViewMatrix(camera, docW, docH, tW, tH);

    // Apply the composed matrix to unit-quad corners → expected NDC.
    const apply = (x: number, y: number) => ({
      x: m.a * x + m.c * y + m.tx,
      y: m.b * x + m.d * y + m.ty,
    });

    // Corner (0,0): physical (100,50) → NDC (2*100/1000-1, 1-2*50/800) = (-0.8, 0.875)
    const p00 = apply(0, 0);
    expect(p00.x).toBeCloseTo(-0.8, 6);
    expect(p00.y).toBeCloseTo(0.875, 6);

    // Corner (1,1): unit→canvas (400,300)→physical scale2+trans = (900, 650).
    // NDC: (2*900/1000-1, 1-2*650/800) = (0.8, -0.625).
    const p11 = apply(1, 1);
    expect(p11.x).toBeCloseTo(0.8, 6);
    expect(p11.y).toBeCloseTo(-0.625, 6);
  });

  it('guards against zero target size (no divide-by-zero)', () => {
    const m = composeViewMatrix(identityCamera, 100, 100, 0, 0);
    expect(Number.isFinite(m.a)).toBe(true);
    expect(Number.isFinite(m.d)).toBe(true);
  });
});

