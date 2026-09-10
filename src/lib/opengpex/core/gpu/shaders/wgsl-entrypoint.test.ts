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
 * wgsl-entrypoint.test.ts — Structural validation of WGSL entry-point IO.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Phase 1-2 suite validated `BLEND_WGSL` with `expect(wgsl).toContain(...)`
 * string assertions and by re-implementing `apply_blend` in TypeScript and
 * comparing numbers. Neither approach can observe a SHADER-LEVEL defect: the
 * WGSL was never handed to a compiler, and no mock reports pipeline-creation
 * failure. As a result a malformed `fs_main` signature shipped while 74/74 GPU
 * tests stayed green — every non-`source-over` blend mode (15 of 16) routes
 * through the ping-pong BlendPass, so the defect blanked the entire canvas.
 *
 * WGSL entry-point IO rule (WGSL §entry-point-attributes): every entry-point
 * parameter must either carry its own `@builtin`/`@location` attribute, or be a
 * struct whose members all carry one. Across the flattened input set a given
 * builtin may appear AT MOST ONCE. Passing a bare `@builtin(position)` param
 * alongside a struct that already declares `@builtin(position)` duplicates it.
 *
 * This test parses the entry-point parameter lists and flattens any struct
 * params, so the duplicate is caught in plain Node with no GPU required. It is
 * a structural guard, NOT a substitute for real compilation — a device-backed
 * `getCompilationInfo()` gate is still the authoritative check.
 */

import { describe, it, expect } from 'vitest';
import { LAYER_WGSL } from './layer';
import { BLEND_WGSL } from './blend';
import { VIEW_WGSL } from './view';

interface ParsedParam {
  readonly name: string;
  readonly type: string;
  /** `@builtin(x)` name, if any. */
  readonly builtin?: string;
  /** `@location(n)` index, if any. */
  readonly location?: number;
}

/** Extract the raw parameter-list text of an entry point (handles newlines). */
function extractParamList(wgsl: string, entryPoint: string): string {
  const re = new RegExp(`fn\\s+${entryPoint}\\s*\\(([\\s\\S]*?)\\)\\s*(?:->|\\{)`);
  const m = wgsl.match(re);
  if (!m) throw new Error(`entry point '${entryPoint}' not found`);
  return m[1];
}

/** Split a parameter list on top-level commas (ignores commas inside `<>` / `()`). */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '<' || ch === '(') depth++;
    else if (ch === '>' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function parseParam(text: string): ParsedParam {
  const builtin = text.match(/@builtin\(\s*(\w+)\s*\)/)?.[1];
  const locRaw = text.match(/@location\(\s*(\d+)\s*\)/)?.[1];
  // Strip attributes, then split `name : type`.
  const bare = text.replace(/@\w+\([^)]*\)/g, '').replace(/@\w+/g, '').trim();
  const colon = bare.indexOf(':');
  const name = (colon === -1 ? bare : bare.slice(0, colon)).trim();
  const type = (colon === -1 ? '' : bare.slice(colon + 1)).trim();
  return {
    name,
    type,
    ...(builtin ? { builtin } : {}),
    ...(locRaw !== undefined ? { location: Number(locRaw) } : {}),
  };
}

/** Parse a `struct Name { ... };` body into its members. */
function parseStructMembers(wgsl: string, structName: string): ParsedParam[] {
  const re = new RegExp(`struct\\s+${structName}\\s*\\{([\\s\\S]*?)\\}`);
  const m = wgsl.match(re);
  if (!m) throw new Error(`struct '${structName}' not found`);
  return splitTopLevel(m[1]).map(parseParam);
}

/**
 * Flatten an entry point's input set: bare params stay as-is, struct params are
 * expanded into their members (one level, which is all WGSL permits for IO).
 */
function flattenEntryInputs(wgsl: string, entryPoint: string): ParsedParam[] {
  const params = splitTopLevel(extractParamList(wgsl, entryPoint)).map(parseParam);
  const flat: ParsedParam[] = [];
  for (const p of params) {
    if (p.builtin || p.location !== undefined) {
      flat.push(p);
      continue;
    }
    // No attribute of its own → must be a struct of attributed members.
    flat.push(...parseStructMembers(wgsl, p.type));
  }
  return flat;
}

const SHADERS: ReadonlyArray<{ name: string; src: string; entries: string[] }> = [
  { name: 'layer.wgsl', src: LAYER_WGSL, entries: ['vs_main', 'fs_main'] },
  { name: 'blend.wgsl', src: BLEND_WGSL, entries: ['vs_main', 'fs_main'] },
  { name: 'view.wgsl', src: VIEW_WGSL, entries: ['vs_main', 'fs_main'] },
];

describe('WGSL entry-point IO validity (structural)', () => {
  for (const { name, src, entries } of SHADERS) {
    for (const entry of entries) {
      it(`${name}:${entry} declares each @builtin at most once across the input set`, () => {
        const inputs = flattenEntryInputs(src, entry);

        const seen = new Map<string, number>();
        for (const p of inputs) {
          if (!p.builtin) continue;
          seen.set(p.builtin, (seen.get(p.builtin) ?? 0) + 1);
        }

        const duplicated = [...seen.entries()].filter(([, n]) => n > 1);
        expect(
          duplicated,
          `duplicated @builtin in ${name}:${entry} → ${duplicated
            .map(([b, n]) => `@builtin(${b}) x${n}`)
            .join(', ')}. WGSL allows a builtin at most once per entry-point ` +
            `input set; a bare @builtin param plus a struct that also declares ` +
            `it is a compile error, and pipeline creation will fail.`,
        ).toEqual([]);
      });

      it(`${name}:${entry} declares each @location at most once across the input set`, () => {
        const inputs = flattenEntryInputs(src, entry);

        const seen = new Map<number, number>();
        for (const p of inputs) {
          if (p.location === undefined) continue;
          seen.set(p.location, (seen.get(p.location) ?? 0) + 1);
        }

        const duplicated = [...seen.entries()].filter(([, n]) => n > 1);
        expect(
          duplicated,
          `duplicated @location in ${name}:${entry} → ${duplicated
            .map(([l, n]) => `@location(${l}) x${n}`)
            .join(', ')}`,
        ).toEqual([]);
      });

      it(`${name}:${entry} gives every input an explicit @builtin or @location`, () => {
        const inputs = flattenEntryInputs(src, entry);
        const unattributed = inputs.filter(
          (p) => !p.builtin && p.location === undefined,
        );
        expect(
          unattributed.map((p) => `${p.name}: ${p.type}`),
          `unattributed entry-point input(s) in ${name}:${entry}`,
        ).toEqual([]);
      });
    }
  }

  it('blend.wgsl fs_main does not re-declare position already carried by VSOut', () => {
    // Pinpoint regression guard for the exact shipped defect: VSOut already has
    // `@builtin(position) clip_pos`, so a second bare `@builtin(position)`
    // parameter is invalid. In the fragment stage `VSOut.clip_pos` IS the
    // fragment coordinate, so the bare param is also redundant.
    const vsOutHasPosition = parseStructMembers(BLEND_WGSL, 'VSOut').some(
      (m) => m.builtin === 'position',
    );
    expect(vsOutHasPosition).toBe(true);

    const bareParams = splitTopLevel(
      extractParamList(BLEND_WGSL, 'fs_main'),
    ).map(parseParam);
    const barePosition = bareParams.filter((p) => p.builtin === 'position');

    expect(
      barePosition.map((p) => p.name),
      'fs_main takes VSOut (which already declares @builtin(position)), so it ' +
        'must not also take a bare @builtin(position) parameter. Read the ' +
        'fragment coordinate from the VSOut member instead.',
    ).toEqual([]);
  });
});
