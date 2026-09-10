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
import { packLayerUniforms } from './CompositePass';
import { MAT3_IDENTITY } from '../../scene/Scene';

describe('packLayerUniforms projection math', () => {
  it('maps unit quad of full-frame layer directly to NDC [-1, 1]', () => {
    const floatTarget = new Float32Array(20);
    const uintTarget = new Uint32Array(floatTarget.buffer);

    // 100x100 layer covering the entire 100x100 frame at origin
    packLayerUniforms(
      floatTarget,
      uintTarget,
      MAT3_IDENTITY,
      100,
      100,
      100,
      100,
      0.85,
      1, // flags
      'rgb',
    );

    // Matrix columns:
    // col 0: [sx * a', sy * b', 0, 0] = [2.0, 0, 0, 0]
    expect(floatTarget[0]).toBeCloseTo(2.0);
    expect(floatTarget[1]).toBeCloseTo(0.0);

    // col 1: [sx * c', sy * d', 0, 0] = [0, -2.0, 0, 0]
    expect(floatTarget[4]).toBeCloseTo(0.0);
    expect(floatTarget[5]).toBeCloseTo(-2.0);

    // col 2: [sx * tx + ox, sy * ty + oy, 1, 0] = [-1.0, 1.0, 1, 0]
    expect(floatTarget[8]).toBeCloseTo(-1.0);
    expect(floatTarget[9]).toBeCloseTo(1.0);

    // Quad point (0, 0) -> NDC:
    // x = 0 * 2.0 + 0 * 0.0 + (-1.0) = -1.0 (left)
    // y = 0 * 0.0 + 0 * -2.0 + 1.0 = 1.0 (top)
    const top_left_x = 0 * floatTarget[0] + 0 * floatTarget[4] + floatTarget[8];
    const top_left_y = 0 * floatTarget[1] + 0 * floatTarget[5] + floatTarget[9];
    expect(top_left_x).toBeCloseTo(-1.0);
    expect(top_left_y).toBeCloseTo(1.0);

    // Quad point (1, 1) -> NDC:
    // x = 1 * 2.0 + 1 * 0.0 + (-1.0) = 1.0 (right)
    // y = 1 * 0.0 + 1 * -2.0 + 1.0 = -1.0 (bottom)
    const bottom_right_x = 1 * floatTarget[0] + 1 * floatTarget[4] + floatTarget[8];
    const bottom_right_y = 1 * floatTarget[1] + 1 * floatTarget[5] + floatTarget[9];
    expect(bottom_right_x).toBeCloseTo(1.0);
    expect(bottom_right_y).toBeCloseTo(-1.0);

    // uv_rect default: [0, 0, 1, 1]
    expect(floatTarget[12]).toBeCloseTo(0.0);
    expect(floatTarget[13]).toBeCloseTo(0.0);
    expect(floatTarget[14]).toBeCloseTo(1.0);
    expect(floatTarget[15]).toBeCloseTo(1.0);

    // Uniform attributes
    expect(floatTarget[16]).toBeCloseTo(0.85); // opacity
    expect(uintTarget[18]).toBe(1); // flags
    expect(uintTarget[19]).toBe(0); // channel_mask 'rgb'
  });

  it('correctly maps translated layer to sub-region of NDC', () => {
    const floatTarget = new Float32Array(20);
    const uintTarget = new Uint32Array(floatTarget.buffer);

    // 50x50 layer on 100x100 frame, placed at (50, 50) [bottom-right quadrant]
    const transform = {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      tx: 50,
      ty: 50,
    };

    packLayerUniforms(
      floatTarget,
      uintTarget,
      transform,
      50,
      50,
      100,
      100,
      1.0,
      0,
      'r',
    );

    // Quad (0,0) is world (50, 50) -> center of screen in NDC (0, 0)
    const tl_x = floatTarget[8];
    const tl_y = floatTarget[9];
    expect(tl_x).toBeCloseTo(0.0);
    expect(tl_y).toBeCloseTo(0.0);

    // Channel mask 'r' maps to value 1
    expect(uintTarget[19]).toBe(1);
  });

  it('correctly offsets fragment quad by localOffset (visibleShape.rect)', () => {
    const floatTarget = new Float32Array(20);
    const uintTarget = new Uint32Array(floatTarget.buffer);

    // Fragment layer with bounding 50x50 at origin, but localOffset at (25, 25)
    packLayerUniforms(
      floatTarget,
      uintTarget,
      MAT3_IDENTITY,
      50,
      50,
      100,
      100,
      1.0,
      8, // LAYER_FLAG_HARD_MASK
      'rgb',
      0,
      [0.25, 0.25, 0.5, 0.5],
      [25, 25],
    );

    // Quad (0, 0) + localOffset (25, 25) -> world (25, 25)
    // NDC x: 25 * (2/100) - 1 = -0.5
    // NDC y: 25 * (-2/100) + 1 = 0.5
    expect(floatTarget[8]).toBeCloseTo(-0.5);
    expect(floatTarget[9]).toBeCloseTo(0.5);
    expect(uintTarget[18]).toBe(8); // hard mask flag
  });
});
