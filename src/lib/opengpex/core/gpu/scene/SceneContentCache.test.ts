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
 * SceneContentCache.test.ts — P1 §4 CPU compose-once/view-many gate.
 *
 * Both-way "还原即失败" guards (mirrors WebGpuEngine.composeCache.test):
 *   • cam-only frame (same layersRef/canvas/colorSpace) → content REUSED, the
 *     builder is NOT re-invoked, and uploads come back EMPTY;
 *   • genuine edit (new layersRef / canvas resize / colorSpace change) → REBUILT;
 *   • an explicit `dirty` tick or an `animating` tick → ALWAYS rebuilt (covers
 *     async decode / tween that mutate content without changing layersRef).
 *
 * If someone regresses the reuse key to include the camera (the 缺陷-5 trap) the
 * "cam-only reuse" test still passes but is meaningless — so we ALSO assert the
 * builder call-count directly, which is the real anti-regression signal.
 */

import { describe, it, expect, vi } from 'vitest';
import { SceneContentCache, type ContentKey } from './SceneContentCache';
import type { SceneContent, LayerNode } from './Scene';
import { MAT3_IDENTITY } from './Scene';
import type { AssetUpload } from './SceneAssembler';

function layer(id = 'L1'): LayerNode {
  return {
    id,
    source: { kind: 'raster', assetId: 'a1' },
    transform: MAT3_IDENTITY,
    opacity: 1,
    blendMode: 'source-over',
  };
}

function content(layers: LayerNode[]): SceneContent {
  return {
    frame: { width: 800, height: 600 },
    artboard: { x: 0, y: 0, w: 800, h: 600 },
    colorSpace: 'srgb',
    hdr: false,
    layers,
  };
}

function key(over: Partial<ContentKey> = {}): ContentKey {
  return {
    layersRef: over.layersRef ?? SHARED_LAYERS,
    canvasW: over.canvasW ?? 800,
    canvasH: over.canvasH ?? 600,
    colorSpace: over.colorSpace ?? 'srgb',
    dirty: over.dirty ?? false,
    animating: over.animating ?? false,
  };
}

const SHARED_LAYERS = [layer()];

/** A builder that records call count and hands back a fresh content each time. */
function trackedBuilder(uploads: AssetUpload[] = []) {
  const fn = vi.fn(() => ({ content: content([layer()]), uploads }));
  return fn;
}

describe('SceneContentCache — P1 §4 CPU compose-once/view-many', () => {
  it('cam-only frame REUSES content and does NOT re-invoke the builder', () => {
    const cache = new SceneContentCache();
    const build = trackedBuilder();

    const first = cache.get(key(), build);
    // A pan/zoom frame: identical content key (same layersRef/canvas/colorSpace).
    const second = cache.get(key(), build);

    expect(build).toHaveBeenCalledTimes(1); // builder ran ONCE
    expect(second.hit).toBe(true);
    expect(second.content).toBe(first.content); // SAME object reference
    expect(cache.wasHit()).toBe(true);
  });

  it('on a hit, uploads come back EMPTY (engine already resident)', () => {
    const cache = new SceneContentCache();
    const build = trackedBuilder([{ assetId: 'a1', bitmap: {} as ImageBitmap }]);

    const first = cache.get(key(), build);
    expect(first.uploads.length).toBe(1); // building frame flushes uploads

    const second = cache.get(key(), build);
    expect(second.hit).toBe(true);
    expect(second.uploads.length).toBe(0); // hit → nothing to re-flush
  });

  it('new layersRef (genuine edit) → REBUILDS', () => {
    const cache = new SceneContentCache();
    const build = trackedBuilder();

    cache.get(key({ layersRef: [layer()] }), build);
    cache.get(key({ layersRef: [layer()] }), build); // different array reference

    expect(build).toHaveBeenCalledTimes(2);
  });

  it('canvas resize → REBUILDS', () => {
    const cache = new SceneContentCache();
    const build = trackedBuilder();

    cache.get(key(), build);
    cache.get(key({ canvasW: 1024, canvasH: 768 }), build);

    expect(build).toHaveBeenCalledTimes(2);
  });

  it('colorSpace change → REBUILDS', () => {
    const cache = new SceneContentCache();
    const build = trackedBuilder();

    cache.get(key(), build);
    cache.get(key({ colorSpace: 'display-p3' }), build);

    expect(build).toHaveBeenCalledTimes(2);
  });

  it('dirty tick ALWAYS rebuilds (async decode / active-frame switch)', () => {
    const cache = new SceneContentCache();
    const build = trackedBuilder();

    cache.get(key(), build); // build
    cache.get(key({ dirty: true }), build); // dirty → rebuild even if layersRef same
    cache.get(key({ dirty: true }), build); // still dirty → rebuild again

    expect(build).toHaveBeenCalledTimes(3);
  });

  it('animating tick ALWAYS rebuilds (tween mutates a display value)', () => {
    const cache = new SceneContentCache();
    const build = trackedBuilder();

    cache.get(key(), build);
    cache.get(key({ animating: true }), build);

    expect(build).toHaveBeenCalledTimes(2);
  });

  it('clear() drops the memo → next get rebuilds', () => {
    const cache = new SceneContentCache();
    const build = trackedBuilder();

    cache.get(key(), build);
    cache.clear();
    const after = cache.get(key(), build);

    expect(build).toHaveBeenCalledTimes(2);
    expect(after.hit).toBe(false);
  });
});
