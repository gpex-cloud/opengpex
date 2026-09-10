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
 * bindgroup-visibility.test.ts — Structural guard: every WGSL binding a shader
 * stage ACTUALLY reads must be granted that stage in its bind group layout.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Blit pipeline shipped with binding 0 (`blit_u`) declared FRAGMENT-only,
 * but `blit.ts` vs_main reads `blit_u.uv_scale`. WebGPU rejected the pipeline
 * at CreateRenderPipeline:
 *
 *   "Entry point's stage (ShaderStage::Vertex) is not in the binding visibility
 *    in the layout (ShaderStage::Fragment)."
 *
 * That invalidated the whole ping-pong command buffer, so selecting any
 * non-`source-over` blend mode blanked the canvas (only the checkerboard left).
 *
 * This test parses each shader for `@group(g) @binding(b) var<...> name`, scans
 * the vertex/fragment bodies for references, and asserts the layout visibility
 * covers every stage that references the binding. Pure Node, no GPU. Still a
 * structural guard — a device-backed pipeline smoke test remains authoritative.
 */

import { describe, it, expect } from 'vitest';
import { LAYER_WGSL } from './layer';
import { BLEND_WGSL } from './blend';
import { VIEW_WGSL } from './view';
import { PipelineCache } from '../resources/PipelineCache';
import { GPUShaderStage } from '../constants';

const VERTEX = GPUShaderStage.VERTEX;
const FRAGMENT = GPUShaderStage.FRAGMENT;

interface Binding {
  readonly group: number;
  readonly binding: number;
  readonly name: string;
}

/** Parse `@group(g) @binding(b) var<...> name : Type;` declarations. */
function parseBindings(wgsl: string): Binding[] {
  const re =
    /@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<[^>]*>)?\s+([A-Za-z_]\w*)/g;
  const out: Binding[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(wgsl)) !== null) {
    out.push({ group: Number(m[1]), binding: Number(m[2]), name: m[3] });
  }
  return out;
}

/** Extract the body text of an `@vertex`/`@fragment` entry point. */
function extractStageBody(wgsl: string, stageAttr: '@vertex' | '@fragment'): string {
  const idx = wgsl.indexOf(stageAttr);
  if (idx === -1) return '';
  const braceStart = wgsl.indexOf('{', idx);
  if (braceStart === -1) return '';
  let depth = 0;
  for (let i = braceStart; i < wgsl.length; i++) {
    if (wgsl[i] === '{') depth++;
    else if (wgsl[i] === '}') {
      depth--;
      if (depth === 0) return wgsl.slice(braceStart + 1, i);
    }
  }
  return wgsl.slice(braceStart + 1);
}

/** Does `body` reference identifier `name` (word-boundary match)? */
function referencesIdent(body: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(body);
}

/**
 * Capture the bind group layout entries a PipelineCache getter builds, by
 * recording createBindGroupLayout calls through a mock device.
 */
function captureLayoutEntries(
  build: (cache: PipelineCache) => void,
): Array<{ binding: number; visibility: number }> {
  let captured: Array<{ binding: number; visibility: number }> = [];
  const device = {
    createBindGroupLayout: (desc: {
      entries: Array<{ binding: number; visibility: number }>;
    }) => {
      captured = desc.entries.map((e) => ({ binding: e.binding, visibility: e.visibility }));
      return {};
    },
    createShaderModule: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createTexture: () => ({ createView: () => ({}) }),
    createSampler: () => ({}),
    createBuffer: () => ({ destroy: () => {} }),
    queue: { writeTexture: () => {}, writeBuffer: () => {} },
    limits: { minUniformBufferOffsetAlignment: 256 },
  } as unknown as GPUDevice;

  const cache = new PipelineCache(device);
  build(cache);
  return captured;
}

interface Case {
  readonly name: string;
  readonly wgsl: string;
  readonly getEntries: () => Array<{ binding: number; visibility: number }>;
}

const CASES: Case[] = [
  {
    name: 'Layer',
    wgsl: LAYER_WGSL,
    getEntries: () => captureLayoutEntries((c) => c.getLayerBindGroupLayout()),
  },
  {
    name: 'Blend',
    wgsl: BLEND_WGSL,
    getEntries: () => captureLayoutEntries((c) => c.getBlendBindGroupLayout()),
  },
  {
    name: 'View',
    wgsl: VIEW_WGSL,
    getEntries: () => captureLayoutEntries((c) => c.getViewBindGroupLayout()),
  },
];

describe('bind group layout visibility matches WGSL usage', () => {
  for (const c of CASES) {
    it(`${c.name}: every stage that reads a binding is granted visibility`, () => {
      const bindings = parseBindings(c.wgsl).filter((b) => b.group === 0);
      expect(bindings.length).toBeGreaterThan(0);

      const vsBody = extractStageBody(c.wgsl, '@vertex');
      const fsBody = extractStageBody(c.wgsl, '@fragment');
      const entries = c.getEntries();

      for (const b of bindings) {
        const entry = entries.find((e) => e.binding === b.binding);
        expect(entry, `${c.name} layout must declare binding ${b.binding}`).toBeDefined();
        const visibility = entry!.visibility;

        if (referencesIdent(vsBody, b.name)) {
          expect(
            (visibility & VERTEX) !== 0,
            `${c.name} binding ${b.binding} (${b.name}) is read by vs_main but layout lacks VERTEX visibility`,
          ).toBe(true);
        }
        if (referencesIdent(fsBody, b.name)) {
          expect(
            (visibility & FRAGMENT) !== 0,
            `${c.name} binding ${b.binding} (${b.name}) is read by fs_main but layout lacks FRAGMENT visibility`,
          ).toBe(true);
        }
      }
    });
  }
});

