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
 * rotation-helpers — math invariant test suite.
 *
 * Every expected value below is HAND-DERIVED (not computed by the functions
 * under test) so that a mutation in the implementation will be caught.
 *
 * Mutation test protocol (§9.3):
 *   1. Replace `((deg % 360) + 360) % 360` with `deg % 360`
 *      → negative-angle cases MUST fail.
 *   2. Replace `Math.round(deg / step) * step` with `Math.floor(deg / step) * step`
 *      → the 53→60 case MUST fail.
 */

import { describe, it, expect } from 'vitest';
import { normalizeAngle, snapAngle } from './rotator';

describe('normalizeAngle', () => {
  // ── Hand-derived expected values ──
  it('keeps 0 as 0', () => {
    expect(normalizeAngle(0)).toBe(0);
  });

  it('keeps values in [0,360) unchanged', () => {
    expect(normalizeAngle(45)).toBe(45);
    expect(normalizeAngle(90)).toBe(90);
    expect(normalizeAngle(180)).toBe(180);
    expect(normalizeAngle(359.5)).toBeCloseTo(359.5, 10);
  });

  it('maps 360 to 0', () => {
    expect(normalizeAngle(360)).toBe(0);
  });

  it('wraps values > 360', () => {
    // 450 = 360 + 90 → 90
    expect(normalizeAngle(450)).toBe(90);
    // 720 = 2×360 → 0
    expect(normalizeAngle(720)).toBe(0);
    // 370 → 10
    expect(normalizeAngle(370)).toBeCloseTo(10, 10);
  });

  it('wraps negative values into [0,360)', () => {
    // -90 → 270  (hand: -90 % 360 = -90, +360 = 270)
    expect(normalizeAngle(-90)).toBe(270);
    // -180 → 180
    expect(normalizeAngle(-180)).toBe(180);
    // -360 → 0
    expect(normalizeAngle(-360)).toBe(0);
    // -1 → 359
    expect(normalizeAngle(-1)).toBe(359);
    // -450 → 270  (hand: -450 % 360 = -90, +360 = 270)
    expect(normalizeAngle(-450)).toBe(270);
  });

  it('handles fractional negative angles', () => {
    // -0.5 → 359.5
    expect(normalizeAngle(-0.5)).toBeCloseTo(359.5, 10);
  });
});

describe('snapAngle', () => {
  // ── Hand-derived expected values (step = 15) ──
  it('snaps to nearest 15° grid point', () => {
    // 0 → 0
    expect(snapAngle(0, 15)).toBe(0);
    // 7 → 0  (7/15 = 0.467, round = 0, 0×15 = 0)
    expect(snapAngle(7, 15)).toBe(0);
    // 8 → 15  (8/15 = 0.533, round = 1, 1×15 = 15)
    expect(snapAngle(8, 15)).toBe(15);
    // 47 → 45  (47/15 = 3.133, round = 3, 3×15 = 45)
    expect(snapAngle(47, 15)).toBe(45);
    // 53 → 60  (53/15 = 3.533, round = 4, 4×15 = 60)
    expect(snapAngle(53, 15)).toBe(60);
    // 90 → 90
    expect(snapAngle(90, 15)).toBe(90);
    // 352 → 345  (352/15 = 23.467, round = 23, 23×15 = 345)
    expect(snapAngle(352, 15)).toBe(345);
    // 353 → 360  (353/15 = 23.533, round = 24, 24×15 = 360)
    expect(snapAngle(353, 15)).toBe(360);
  });

  it('snaps negative angles correctly', () => {
    // -8 → -15  (-8/15 = -0.533, Math.round → -1, -1×15 = -15)
    expect(snapAngle(-8, 15)).toBe(-15);
    // -7 → -0  (-7/15 = -0.467, Math.round → 0, 0×15 = -0 in IEEE 754)
    // In practice the caller wraps via normalizeAngle(-0) → 0. Just verify
    // the magnitude is correct here.
    expect(snapAngle(-7, 15) + 0).toBe(0);
  });

  it('works with step = 45', () => {
    expect(snapAngle(20, 45)).toBe(0);
    // 23 → 45  (23/45 = 0.511, round = 1, 1×45 = 45)
    expect(snapAngle(23, 45)).toBe(45);
    expect(snapAngle(44, 45)).toBe(45);
    expect(snapAngle(90, 45)).toBe(90);
  });

  it('is identity when angle is already on grid', () => {
    for (const a of [0, 15, 30, 45, 60, 75, 90, 180, 270, 345, 360]) {
      expect(snapAngle(a, 15)).toBe(a);
    }
  });
});
