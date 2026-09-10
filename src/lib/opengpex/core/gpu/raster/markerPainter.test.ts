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
import { paintMarker, markerToSvg } from './markerPainter';
import type { RectMarkerData, ArrowMarkerData, EllipseMarkerData } from '@opengpex/editor/core/types';

/**
 * Recording mock 2D context — captures the sequence of drawing calls and the
 * mutable style state so we can assert paintMarker's behavior without a real
 * canvas (the vitest environment is node-based, no DOM canvas).
 */
function createMockCtx() {
  const calls: string[] = [];
  const state: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      // Any unknown property access returns a recording function.
      const fn = (...args: unknown[]) => {
        calls.push(`${prop}(${args.join(',')})`);
      };
      return fn;
    },
    set(target, prop: string, value) {
      state[prop] = value;
      target[prop] = value;
      return true;
    },
  };
  const ctx = new Proxy({}, handler) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, state };
}

const RECT: RectMarkerData = {
  kind: 'rect',
  stroke: { color: '#FF3B30', width: 4 },
  fill: { color: '#FF3B30', opacity: 0.2 },
  cornerRadius: 8,
};

const ARROW: ArrowMarkerData = {
  kind: 'arrow',
  stroke: { color: '#0A84FF', width: 6 },
  fill: { color: '#000000', opacity: 0 },
  tail: { x: 0, y: 0 },
  head: { x: 100, y: 50 },
  headScale: 3,
};

const ELLIPSE: EllipseMarkerData = {
  kind: 'ellipse',
  stroke: { color: '#34C759', width: 4 },
  fill: { color: '#34C759', opacity: 0.2 },
};

describe('paintMarker — rect', () => {
  it('fills and strokes a rounded rect inset by half the stroke width', () => {
    const { ctx, calls } = createMockCtx();
    paintMarker(ctx, RECT, { w: 120, h: 80 });

    // rounded rect uses arcTo (roundRect avoided for OffscreenCanvas parity)
    expect(calls.filter((c) => c.startsWith('arcTo(')).length).toBe(4);
    expect(calls).toContain('fill()');
    expect(calls).toContain('stroke()');
  });

  it('skips fill when opacity is 0', () => {
    const { ctx, calls } = createMockCtx();
    paintMarker(ctx, { ...RECT, fill: { color: '#fff', opacity: 0 } }, { w: 120, h: 80 });
    expect(calls).not.toContain('fill()');
    expect(calls).toContain('stroke()');
  });

  it('draws nothing when the box is smaller than the stroke', () => {
    const { ctx, calls } = createMockCtx();
    paintMarker(ctx, RECT, { w: 2, h: 2 });
    expect(calls).not.toContain('stroke()');
    expect(calls).not.toContain('fill()');
  });
});

describe('paintMarker — arrow', () => {
  it('draws a shaft (stroke) and a filled arrowhead', () => {
    const { ctx, calls } = createMockCtx();
    paintMarker(ctx, ARROW, { w: 100, h: 50 });
    expect(calls).toContain('stroke()');
    expect(calls).toContain('fill()');
    // shaft: moveTo tail + lineTo shaft-end; head: triangle path
    expect(calls.filter((c) => c.startsWith('beginPath(')).length).toBe(2);
  });

  it('draws nothing for a zero-length arrow', () => {
    const { ctx, calls } = createMockCtx();
    paintMarker(ctx, { ...ARROW, head: { x: 0, y: 0 } }, { w: 1, h: 1 });
    expect(calls).not.toContain('stroke()');
    expect(calls).not.toContain('fill()');
  });
});

describe('paintMarker — ellipse', () => {
  it('fills and strokes an inscribed ellipse inset by half the stroke width', () => {
    const { ctx, calls } = createMockCtx();
    paintMarker(ctx, ELLIPSE, { w: 120, h: 80 });
    expect(calls.filter((c) => c.startsWith('ellipse(')).length).toBe(1);
    expect(calls).toContain('fill()');
    expect(calls).toContain('stroke()');
  });

  it('skips fill when opacity is 0', () => {
    const { ctx, calls } = createMockCtx();
    paintMarker(ctx, { ...ELLIPSE, fill: { color: '#fff', opacity: 0 } }, { w: 120, h: 80 });
    expect(calls).not.toContain('fill()');
    expect(calls).toContain('stroke()');
  });

  it('draws nothing when the box is smaller than the stroke', () => {
    const { ctx, calls } = createMockCtx();
    paintMarker(ctx, ELLIPSE, { w: 2, h: 2 });
    expect(calls).not.toContain('stroke()');
    expect(calls).not.toContain('fill()');
  });
});

describe('markerToSvg', () => {
  it('emits a <rect> with stroke and fill-opacity for rect markers', () => {
    const svg = markerToSvg(RECT, { w: 120, h: 80 });
    expect(svg).toContain('<rect');
    expect(svg).toContain('stroke="#FF3B30"');
    expect(svg).toContain('fill-opacity="0.2"');
    expect(svg).toContain('rx="8"');
  });

  it('emits a <line> + <polygon> for arrow markers', () => {
    const svg = markerToSvg(ARROW, { w: 100, h: 50 });
    expect(svg).toContain('<line');
    expect(svg).toContain('<polygon');
    expect(svg).toContain('stroke="#0A84FF"');
  });

  it('emits an <ellipse> with stroke and fill-opacity for ellipse markers', () => {
    const svg = markerToSvg(ELLIPSE, { w: 120, h: 80 });
    expect(svg).toContain('<ellipse');
    expect(svg).toContain('stroke="#34C759"');
    expect(svg).toContain('fill-opacity="0.2"');
  });
});
