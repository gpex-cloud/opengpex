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

import { describe, it, expect } from 'vitest';
import { SceneCompiler } from './SceneCompiler';
import { EMPTY_SCENE, MAT3_IDENTITY, type Scene, type LayerNode } from '../scene/Scene';

function makeLayer(id: string, blendMode: LayerNode['blendMode']): LayerNode {
  return {
    id,
    source: { kind: 'raster', assetId: `asset-${id}` },
    transform: MAT3_IDENTITY,
    opacity: 1.0,
    blendMode,
  };
}

describe('SceneCompiler batching logic', () => {
  it('returns pure direct and empty steps for empty scene', () => {
    const compiled = SceneCompiler.compile(EMPTY_SCENE);
    expect(compiled.isPureDirect).toBe(true);
    expect(compiled.steps.length).toBe(0);
  });

  it('merges consecutive hardware-blendable (source-over) layers into a single batch', () => {
    const scene: Scene = {
      ...EMPTY_SCENE,
      layers: [
        makeLayer('l1', 'source-over'),
        makeLayer('l2', 'source-over'),
        makeLayer('l3', 'source-over'),
      ],
    };

    const compiled = SceneCompiler.compile(scene);
    expect(compiled.isPureDirect).toBe(true);
    expect(compiled.steps.length).toBe(1);
    expect(compiled.steps[0].kind).toBe('separable');
    if (compiled.steps[0].kind === 'separable') {
      expect(compiled.steps[0].layers.length).toBe(3);
      expect(compiled.steps[0].layers.map((l) => l.id)).toEqual(['l1', 'l2', 'l3']);
    }
  });

  it('routes W3C-separable-but-not-hardware modes (multiply/screen/darken) to ping-pong', () => {
    // core §7.2 P0: these are NOT hardware-blendable; each must be its own step.
    const scene: Scene = {
      ...EMPTY_SCENE,
      layers: [
        makeLayer('l1', 'source-over'),
        makeLayer('l2', 'multiply'),
        makeLayer('l3', 'screen'),
        makeLayer('l4', 'darken'),
      ],
    };

    const compiled = SceneCompiler.compile(scene);
    expect(compiled.isPureDirect).toBe(false);
    // l1 (separable batch) + multiply + screen + darken (3 ping-pong steps).
    expect(compiled.steps.length).toBe(4);
    expect(compiled.steps[0].kind).toBe('separable');
    expect(compiled.steps[1].kind).toBe('non-separable');
    expect(compiled.steps[2].kind).toBe('non-separable');
    expect(compiled.steps[3].kind).toBe('non-separable');
    if (compiled.steps[1].kind === 'non-separable') {
      expect(compiled.steps[1].layer.id).toBe('l2');
      expect(compiled.steps[1].layer.blendMode).toBe('multiply');
    }
  });

  it('splits batches on class-B blend modes (isPureDirect: false)', () => {
    const scene: Scene = {
      ...EMPTY_SCENE,
      layers: [
        makeLayer('l1', 'source-over'),
        makeLayer('l2', 'source-over'),
        makeLayer('l3', 'overlay'), // class B
        makeLayer('l4', 'source-over'),
        makeLayer('l5', 'soft-light'), // class B
      ],
    };

    const compiled = SceneCompiler.compile(scene);
    expect(compiled.isPureDirect).toBe(false);
    expect(compiled.steps.length).toBe(4);

    // Step 0: separable batch (l1, l2)
    expect(compiled.steps[0].kind).toBe('separable');
    if (compiled.steps[0].kind === 'separable') {
      expect(compiled.steps[0].layers.map((l) => l.id)).toEqual(['l1', 'l2']);
    }

    // Step 1: ping-pong (l3)
    expect(compiled.steps[1].kind).toBe('non-separable');
    if (compiled.steps[1].kind === 'non-separable') {
      expect(compiled.steps[1].layer.id).toBe('l3');
    }

    // Step 2: separable batch (l4)
    expect(compiled.steps[2].kind).toBe('separable');
    if (compiled.steps[2].kind === 'separable') {
      expect(compiled.steps[2].layers.map((l) => l.id)).toEqual(['l4']);
    }

    // Step 3: ping-pong (l5)
    expect(compiled.steps[3].kind).toBe('non-separable');
    if (compiled.steps[3].kind === 'non-separable') {
      expect(compiled.steps[3].layer.id).toBe('l5');
    }
  });

  it('handles first layer being class B', () => {
    const scene: Scene = {
      ...EMPTY_SCENE,
      layers: [
        makeLayer('l1', 'difference'), // non-separable
        makeLayer('l2', 'source-over'),
      ],
    };

    const compiled = SceneCompiler.compile(scene);
    expect(compiled.isPureDirect).toBe(false);
    expect(compiled.steps.length).toBe(2);
    expect(compiled.steps[0].kind).toBe('non-separable');
    expect(compiled.steps[1].kind).toBe('separable');
  });
});
