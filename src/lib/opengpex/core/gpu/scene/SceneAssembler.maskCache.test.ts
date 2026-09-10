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
 * SceneAssembler.maskCache.test.ts — WP-3.1 vectorMaskCache leak fix.
 *
 * The cache must (a) close() the previous bitmap when an entry is refreshed,
 * (b) evict + close() the oldest entry past the LRU cap, and (c) fully release
 * every bitmap on clearVectorMaskCache().
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  setVectorMaskCache,
  clearVectorMaskCache,
  vectorMaskCacheSize,
} from './SceneAssembler';

interface TrackedBitmap extends ImageBitmap {
  closed: boolean;
}

function trackedBitmap(): TrackedBitmap {
  const bmp = {
    width: 64,
    height: 64,
    closed: false,
    close() {
      (this as TrackedBitmap).closed = true;
    },
  };
  return bmp as unknown as TrackedBitmap;
}

describe('vectorMaskCache lifecycle (WP-3.1)', () => {
  afterEach(() => {
    clearVectorMaskCache();
  });

  it('closes the previous bitmap when the same layer key is refreshed', () => {
    const first = trackedBitmap();
    const second = trackedBitmap();
    setVectorMaskCache('L1', 'k1', first);
    setVectorMaskCache('L1', 'k2', second);

    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(vectorMaskCacheSize()).toBe(1);
  });

  it('evicts and closes the oldest entry past the LRU cap', () => {
    const bitmaps: TrackedBitmap[] = [];
    // Insert well past the cap (32) to force eviction of the earliest inserts.
    for (let i = 0; i < 40; i++) {
      const b = trackedBitmap();
      bitmaps.push(b);
      setVectorMaskCache(`layer-${i}`, `key-${i}`, b);
    }

    // Cache never exceeds the cap.
    expect(vectorMaskCacheSize()).toBeLessThanOrEqual(32);
    // The earliest 8 entries were evicted and closed.
    expect(bitmaps[0].closed).toBe(true);
    expect(bitmaps[7].closed).toBe(true);
    // The most recent entries remain open.
    expect(bitmaps[39].closed).toBe(false);
  });

  it('closes every bitmap on clearVectorMaskCache()', () => {
    const a = trackedBitmap();
    const b = trackedBitmap();
    setVectorMaskCache('A', 'ka', a);
    setVectorMaskCache('B', 'kb', b);
    expect(vectorMaskCacheSize()).toBe(2);

    clearVectorMaskCache();

    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
    expect(vectorMaskCacheSize()).toBe(0);
  });
});
