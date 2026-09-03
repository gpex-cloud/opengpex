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
 * Unit suite for `polygonToShape` — the pure Polygon → Shape serializer moved
 * from `helpers/path2d.ts` into the DOM-free geometry engine (`operators/polygon.ts`).
 *
 * Being in the geometry layer now makes it directly unit-testable (no Canvas/DOM),
 * which is the primary payoff of the path2d.ts DOM-dependency split.
 */

import { describe, it, expect } from 'vitest';
import { polygonToShape } from './polygon';
import { rectToLocalPolygon, ellipseToLocalPolygon } from './point2d';
import { asLocalRect, asLocalPolygon, type LocalPoint } from '@opengpex/editor/core/types';

describe('polygonToShape', () => {
  it('recognizes a 4-point axis-aligned ring as type:rect', () => {
    const poly = rectToLocalPolygon(asLocalRect({ x: 10, y: 20, w: 30, h: 40 }));
    const shape = polygonToShape(poly);
    expect(shape.type).toBe('rect');
    expect(shape.rect).toMatchObject({ x: 10, y: 20, w: 30, h: 40 });
    expect(shape.__brand).toBe('local');
  });

  it('recognizes a 64-point ellipse ring as type:circle', () => {
    const poly = ellipseToLocalPolygon(asLocalRect({ x: 0, y: 0, w: 100, h: 60 }));
    const shape = polygonToShape(poly);
    expect(shape.type).toBe('circle');
    expect(shape.rect).toMatchObject({ x: 0, y: 0, w: 100, h: 60 });
  });

  it('serializes an irregular polygon to smooth M/L/Z pathData (type:path)', () => {
    // A triangle — not recognizable as rect/circle → path.
    const rings = [[
      { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 30 },
    ]] as unknown as LocalPoint[][];
    const poly = asLocalPolygon(rings, asLocalRect({ x: 0, y: 0, w: 40, h: 30 }), true);
    const shape = polygonToShape(poly);
    expect(shape.type).toBe('path');
    expect((shape as { pathData?: string }).pathData).toBe('M 0 0 L 40 0 L 20 30 Z');
    // pathData is always smooth (no stair-stepping baked in at serialization).
    expect((shape as { pathData?: string }).pathData).not.toContain('H ');
  });

  it('preserves antiAliased=false on the output shape (render-time AA routing)', () => {
    const rings = [[
      { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 30 },
    ]] as unknown as LocalPoint[][];
    const poly = asLocalPolygon(rings, asLocalRect({ x: 0, y: 0, w: 40, h: 30 }), false);
    const shape = polygonToShape(poly);
    expect(shape.antiAliased).toBe(false);
    // Still smooth at serialization — stair-stepping happens later in shapeToPath2D.
    expect((shape as { pathData?: string }).pathData).toBe('M 0 0 L 40 0 L 20 30 Z');
  });

  it('drops degenerate (<3-point) rings via the shared ringsToPathData serializer', () => {
    // Two rings: one valid triangle, one degenerate 2-point line.
    const rings = [
      [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 30 }],
      [{ x: 5, y: 5 }, { x: 6, y: 6 }],
    ] as unknown as LocalPoint[][];
    const poly = asLocalPolygon(rings, asLocalRect({ x: 0, y: 0, w: 40, h: 30 }), true);
    const shape = polygonToShape(poly);
    // Only the valid ring survives.
    expect((shape as { pathData?: string }).pathData).toBe('M 0 0 L 40 0 L 20 30 Z');
  });
});
