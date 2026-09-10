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
 * compositeSignature.test.ts — 缺陷 5 §5 阶段 2 miss-detection guard (R2).
 *
 * The composite cache is only correct if the signature changes for EVERY field
 * that affects the composited pixels, and does NOT change for the camera/view
 * (that would defeat the whole fix). These are the "还原即失败" both-way guards:
 * each compose-affecting field flips the signature; view/channel changes don't.
 */

import { describe, it, expect } from 'vitest';
import { computeCompositeSignature, type CompositeSignatureOptions } from './compositeSignature';
import { MAT3_IDENTITY, type Scene, type LayerNode } from './Scene';

const OPTS: CompositeSignatureOptions = { getAssetEpoch: () => 0, workingFormat: 'rgba16float' };

function layer(over: Partial<LayerNode> = {}): LayerNode {
  return {
    id: 'L1',
    source: { kind: 'raster', assetId: 'a1' },
    transform: MAT3_IDENTITY,
    opacity: 1,
    blendMode: 'source-over',
    ...over,
  };
}

function scene(over: Partial<Scene> = {}): Scene {
  return {
    frame: { width: 800, height: 600 },
    display: { channelMask: 'rgb', colorSpace: 'srgb', hdr: false },
    view: { transform: MAT3_IDENTITY, target: { width: 1600, height: 1200 } },
    layers: [layer()],
    ...over,
  };
}

const sig = (s: Scene, o: CompositeSignatureOptions = OPTS) => computeCompositeSignature(s, o);

describe('computeCompositeSignature — stable when nothing composite-relevant changes', () => {
  it('is identical for two structurally-equal scenes (new object each frame)', () => {
    expect(sig(scene())).toBe(sig(scene()));
  });

  it('does NOT change when only the camera (view.transform) changes — the whole point', () => {
    const a = sig(scene());
    const b = sig(scene({ view: { transform: { a: 2, b: 0, c: 0, d: 2, tx: 50, ty: 60 }, target: { width: 1600, height: 1200 } } }));
    expect(a).toBe(b);
  });

  it('does NOT change when only view.target (swapchain size) changes', () => {
    const a = sig(scene());
    const b = sig(scene({ view: { transform: MAT3_IDENTITY, target: { width: 999, height: 777 } } }));
    expect(a).toBe(b);
  });

  it('does NOT change when only display.channelMask changes (applied in view pass)', () => {
    const a = sig(scene());
    const b = sig(scene({ display: { channelMask: 'r', colorSpace: 'srgb', hdr: false } }));
    expect(a).toBe(b);
  });
});

describe('computeCompositeSignature — changes for every composite-affecting field (R2)', () => {
  const base = scene();

  it('frame size', () => {
    expect(sig(base)).not.toBe(sig(scene({ frame: { width: 801, height: 600 } })));
  });
  it('working format', () => {
    expect(sig(base)).not.toBe(sig(base, { ...OPTS, workingFormat: 'rgba32float' }));
  });
  it('layer transform', () => {
    expect(sig(base)).not.toBe(sig(scene({ layers: [layer({ transform: { ...MAT3_IDENTITY, tx: 1 } })] })));
  });
  it('opacity', () => {
    expect(sig(base)).not.toBe(sig(scene({ layers: [layer({ opacity: 0.5 })] })));
  });
  it('blendMode', () => {
    expect(sig(base)).not.toBe(sig(scene({ layers: [layer({ blendMode: 'multiply' })] })));
  });
  it('clip', () => {
    expect(sig(base)).not.toBe(sig(scene({ layers: [layer({ clip: true })] })));
  });
  it('crop', () => {
    expect(sig(base)).not.toBe(sig(scene({ layers: [layer({ crop: { x: 0, y: 0, w: 10, h: 10 } })] })));
  });
  it('width/height', () => {
    expect(sig(base)).not.toBe(sig(scene({ layers: [layer({ width: 123 })] })));
  });
  it('dprScale (§fix/20260911 — physical vs logical crop→UV mapping)', () => {
    expect(sig(base)).not.toBe(sig(scene({ layers: [layer({ dprScale: 2 })] })));
  });
  it('assetId', () => {
    expect(sig(base)).not.toBe(sig(scene({ layers: [layer({ source: { kind: 'raster', assetId: 'a2' } })] })));
  });
  it('layer order', () => {
    const twoA = scene({ layers: [layer({ id: 'L1' }), layer({ id: 'L2' })] });
    const twoB = scene({ layers: [layer({ id: 'L2' }), layer({ id: 'L1' })] });
    expect(sig(twoA)).not.toBe(sig(twoB));
  });
  it('layer add/remove', () => {
    expect(sig(base)).not.toBe(sig(scene({ layers: [layer(), layer({ id: 'L2' })] })));
  });
  it('bitmap mask presence + fields', () => {
    const masked = scene({ layers: [layer({ mask: { kind: 'bitmap', maskId: 'm1', inverted: false } })] });
    const maskedInv = scene({ layers: [layer({ mask: { kind: 'bitmap', maskId: 'm1', inverted: true } })] });
    expect(sig(base)).not.toBe(sig(masked));
    expect(sig(masked)).not.toBe(sig(maskedInv));
  });

  it('asset EPOCH bump (same assetId, edited pixels) — the R2 miss-detection defence', () => {
    const before = sig(base, { getAssetEpoch: () => 0, workingFormat: 'rgba16float' });
    const after = sig(base, { getAssetEpoch: () => 1, workingFormat: 'rgba16float' });
    expect(before).not.toBe(after);
  });
});
