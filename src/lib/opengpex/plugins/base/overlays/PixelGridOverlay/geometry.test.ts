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
import { pixelScreenSize, shouldShowPixelGrid } from './geometry';
import { DEFAULT_MIN_PIXEL_SIZE } from './protocols';

describe('pixelScreenSize — source/document px → screen physical px (§8, step 9)', () => {
  it('is camera.k × dpr', () => {
    expect(pixelScreenSize(2, 2)).toBe(4);
    expect(pixelScreenSize(3, 1)).toBe(3);
    expect(pixelScreenSize(1, 1)).toBe(1);
  });
});

describe('shouldShowPixelGrid — criterion p >= N (GIMP-style)', () => {
  it('N boundary: exactly N shows, just below hides', () => {
    // dpr=2, N=4 → threshold camera.k = 2.0
    expect(shouldShowPixelGrid(2.0, 2, 4)).toBe(true);
    expect(shouldShowPixelGrid(1.999, 2, 4)).toBe(false);
  });

  it('default N = 12', () => {
    expect(DEFAULT_MIN_PIXEL_SIZE).toBe(12);
  });

  // ─── The core acceptance property: decoupled from image size / fit / DPR ───
  //
  // Two images of very different sizes get very different fit-camera `k` values,
  // but the grid must appear at the SAME on-screen pixel size. We model this by
  // deriving, for each scenario, the camera.k at which one source pixel reaches
  // the target physical size, and asserting the criterion flips at that same
  // physical size regardless of the (size/fit/DPR)-driven k.

  describe('appears at the same physical pixel size regardless of image size / fit / DPR', () => {
    const N = DEFAULT_MIN_PIXEL_SIZE;

    // Scenario = { label, dpr, fitK }. fitK is the initial fit zoom that differs
    // wildly by image size, but MUST NOT affect when the grid appears.
    const scenarios = [
      { label: '1000² @ dpr1, fit k≈0.7', dpr: 1, fitK: 0.7 },
      { label: '3000² @ dpr1, fit k≈0.23', dpr: 1, fitK: 0.23 },
      { label: '1000² @ dpr2, fit k≈0.7', dpr: 2, fitK: 0.7 },
      { label: '3000² @ dpr3, fit k≈0.23', dpr: 3, fitK: 0.23 },
    ];

    for (const s of scenarios) {
      it(`${s.label}: grid onset at p == N, not at any fixed k`, () => {
        // camera.k that makes one source px exactly N physical px:
        const onsetK = N / s.dpr;
        // Just below onset → hidden; at/above onset → shown.
        expect(shouldShowPixelGrid(onsetK - 1e-6, s.dpr, N)).toBe(false);
        expect(shouldShowPixelGrid(onsetK, s.dpr, N)).toBe(true);
        // Physical size at onset is identical across ALL scenarios:
        expect(pixelScreenSize(onsetK, s.dpr)).toBeCloseTo(N, 6);
      });
    }

    it('the same k gives DIFFERENT verdicts across DPRs (proves DPR is honored)', () => {
      // With N=8: k=6 → dpr=1 gives p=6 (< 8, hidden); dpr=2 gives p=12 (>= 8, shown).
      expect(shouldShowPixelGrid(6, 1, 8)).toBe(false);
      expect(shouldShowPixelGrid(6, 2, 8)).toBe(true);
    });
  });

  // ─── Bidirectional guard: reverting the criterion must fail ───
  it('reversed criterion (< instead of >=) would break the boundary', () => {
    const reversed = (k: number, dpr: number, n: number) =>
      pixelScreenSize(k, dpr) < n;
    // At the exact boundary the real criterion says SHOW; a reversed one says HIDE.
    expect(shouldShowPixelGrid(2, 2, 4)).toBe(true);
    expect(reversed(2, 2, 4)).toBe(false);
  });
});
