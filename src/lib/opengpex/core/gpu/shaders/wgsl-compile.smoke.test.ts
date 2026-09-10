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
 * wgsl-compile.smoke.test.ts — DEVICE-SIDE authoritative gate for the WGSL
 * shaders and render pipelines (§6 修复计划 步骤 4).
 *
 * WHY THIS EXISTS
 * ---------------
 * `wgsl-entrypoint.test.ts` and `bindgroup-visibility.test.ts` are pure-Node
 * STRUCTURAL guards — they parse the WGSL text but never hand it to a compiler.
 * That is exactly the blind spot that let 缺陷 1 ship: 15/16 blend modes had a
 * shader that failed `createShaderModule` / `createRenderPipeline` on a real
 * device, yet every Node test stayed green.
 *
 * This test closes that gap by exercising the REAL WebGPU path:
 *   ① createShaderModule for layer / blend / blit, then assert
 *      getCompilationInfo() reports ZERO error-severity messages.
 *   ② Actually create the layer / blend / blit render pipelines under an error
 *      scope and assert no GPUValidationError (this is where the 缺陷 1 环④ Blit
 *      binding-visibility mismatch would surface).
 *
 * ENVIRONMENT GATING
 * ------------------
 * WebGPU is unavailable under Node / jsdom (the default CI + local `vitest`
 * environment), so `navigator.gpu` is undefined and the whole suite SKIPS
 * cleanly — it never fails for "no GPU". It only runs (and becomes
 * authoritative) when executed in a real WebGPU-capable environment, e.g.
 *   `vitest --browser` on Chromium, or a Playwright/WebGPU runner.
 *
 * This is a smoke test, deliberately format-agnostic: it probes the adapter's
 * preferred format + rgba16float working format so it matches what GpuDevice
 * would actually pick, without importing the whole engine bootstrap.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PipelineCache } from '../resources/PipelineCache';

/** Runtime probe: is a real WebGPU device reachable here? */
const gpu: GPU | undefined =
  typeof navigator !== 'undefined'
    ? (navigator as Navigator & { gpu?: GPU }).gpu
    : undefined;

// describe.skipIf keeps the suite green (skipped, not failed) on Node/CI.
describe.skipIf(!gpu)('WGSL device-side compile + pipeline smoke test', () => {
  let device: GPUDevice;
  let cache: PipelineCache;
  // The swapchain-facing format the blit targets; probed from the adapter so
  // the test matches real bootstrap. rgba16float is the working/composite
  // format for layer + blend passes (spec §6, format-conflict fix 环③).
  let targetFormat: GPUTextureFormat;
  const workingFormat: GPUTextureFormat = 'rgba16float';

  beforeAll(async () => {
    const adapter = await gpu!.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('requestAdapter() returned null on a GPU-capable env');
    device = await adapter.requestDevice();
    cache = new PipelineCache(device);
    targetFormat =
      typeof gpu!.getPreferredCanvasFormat === 'function'
        ? gpu!.getPreferredCanvasFormat()
        : 'bgra8unorm';
  });

  afterAll(() => {
    cache?.destroy();
    device?.destroy();
  });

  it('layer / blend / view WGSL modules compile with zero error-severity messages', async () => {
    const modules: Array<[string, GPUShaderModule]> = [
      ['layer', cache.getLayerShaderModule()],
      ['blend', cache.getBlendShaderModule()],
      ['view', cache.getViewShaderModule()],
    ];

    for (const [name, mod] of modules) {
      // getCompilationInfo is the authoritative WGSL diagnostic surface.
      const info = await mod.getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === 'error');
      expect(
        errors.map((e) => `${e.lineNum}:${e.linePos} ${e.message}`),
        `${name}.wgsl must compile without errors`,
      ).toEqual([]);
    }
  });

  it('layer / blend / view render pipelines create without validation errors', async () => {
    // Error scopes capture async pipeline-creation validation failures — e.g.
    // the 缺陷 1 环④ "binding 0 not visible to vertex stage" would pop here.
    device.pushErrorScope('validation');

    // Layer pipeline: composited working format; probe the non-bottom-opaque,
    // source-over variant (the common path).
    cache.getLayerPipeline('source-over', workingFormat, false);
    // Blend (ping-pong) pipeline: also working format.
    cache.getBlendPipeline(workingFormat);
    // View pipeline: swapchain target format (缺陷 5 §5, supersedes blit).
    cache.getViewPipeline(targetFormat);

    const err = await device.popErrorScope();
    expect(err, err ? `pipeline creation raised: ${err.message}` : '').toBeNull();
  });
});
