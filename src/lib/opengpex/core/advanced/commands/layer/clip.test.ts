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
 * Acceptance suite for the Apply-Mask VectorMask migration + drill legacy
 * BitmapMask removal (20260903_apply_mask_vmask_migration_spec.md §8).
 *
 * Strategy (per §8 note): these are node pure-function tests that exercise the
 * REAL command `execute` bodies through the REAL geometry + layer services.
 * They assert structural invariants (mask type / count / coordinates / degrade
 * behavior). The purely visual cases (§8.3 posed-layer render, §8.5 soft-edge
 * render, §8.8 erase-after-apply pixels) are covered structurally here and
 * flagged for Canvas smoke in the spec.
 */

import { describe, it, expect } from 'vitest';
import { createGeometryService } from '@opengpex/editor/core/geometry';
import { createLayerService } from '@opengpex/editor/core/layer';
import { LayerClipCommands } from '@opengpex/editor/core/advanced/commands/layer/clip';
import { getEffectiveVisibleShape, intersectWithLayer } from '@opengpex/editor/core/geometry/operators/shape';
import {
  asLocalShape,
  type GeometryService,
  type Frame,
  type Layer,
  type LocalPolygon,
  type Point2D,
  type EditorContextValue,
  type BitmapMask,
} from '@opengpex/editor/core/types';

// ─── Harness ─────────────────────────────────────────────────────────────────

const geometry: GeometryService = createGeometryService();

const FRAME_ID = 'F1';
const LAYER_ID = 'L1';

interface Harness {
  ctx: EditorContextValue;
  state: { frames: { byId: Record<string, Frame> } };
  errorPulses: number;
  layer(): Layer;
  setRectSelection(x: number, y: number, w: number, h: number): void;
  setLassoSelection(points: Point2D[]): void;
}

function makeLayer(overrides: Partial<Layer> = {}): Layer {
  return {
    id: LAYER_ID,
    name: 'L1',
    type: 'image',
    src: 'data:,',
    assetId: 'asset-x',
    cx: 0,
    cy: 0,
    scale: 1,
    rotation: 0,
    flip: { h: false, v: false },
    bounding: { w: 100, h: 100 },
    visibleShape: asLocalShape({ x: 0, y: 0, w: 100, h: 100 }, 'rect'),
    vectorMasks: [],
    bitmapMasks: [],
    visible: true,
    locked: false,
    opacity: 1,
    ...overrides,
  } as unknown as Layer;
}

function makeHarness(layerOverrides: Partial<Layer> = {}): Harness {
  const layer = makeLayer(layerOverrides);

  const frame = {
    id: FRAME_ID,
    name: 'F1',
    canvas: { w: 100, h: 100 },
    dpi: 72,
    bitDepth: 8,
    colorSpace: 'srgb',
    trc: 'srgb-trc',
    camera: { x: 0, y: 0, k: 1 },
    layers: {
      byId: { [LAYER_ID]: layer },
      order: [LAYER_ID],
    },
    activeLayerId: LAYER_ID,
    clipBoxes: {} as Record<string, LocalPolygon>,
    canvasClipBox: asLocalShape({ x: 0, y: 0, w: 100, h: 100 }, 'rect'),
    latestClipTool: 'rect',
  } as unknown as Frame;

  const state = { frames: { byId: { [FRAME_ID]: frame } as Record<string, Frame> } };

  const harness = { errorPulses: 0 } as Harness;

  const actions = {
    setInteraction: (patch: Record<string, unknown>) => {
      if ('selectionErrorPulse' in patch) harness.errorPulses++;
    },
    batchUpdateLayers: (frameId: string, patches: Record<string, Partial<Layer>>) => {
      const f = state.frames.byId[frameId];
      for (const [id, patch] of Object.entries(patches)) {
        f.layers.byId[id] = { ...f.layers.byId[id], ...patch } as Layer;
      }
    },
    fast: {
      latestLayer: (frameId: string, id: string) => state.frames.byId[frameId]?.layers.byId[id] ?? null,
    },
  };

  const layers = createLayerService(
    geometry,
    {} as never, // pixels — unused by toMask/drill after migration
    {} as never, // assets — unused by toMask/drill after migration
    actions as never,
    () => state as never,
  );

  const ctx = {
    get activeFrame() { return state.frames.byId[FRAME_ID]; },
    get activeLayer() { return state.frames.byId[FRAME_ID].layers.byId[LAYER_ID]; },
    actions,
    geometry,
    layers,
    state: { interaction: { interactionMode: 'clip' } },
  } as unknown as EditorContextValue;

  harness.ctx = ctx;
  harness.state = state;
  harness.layer = () => state.frames.byId[FRAME_ID].layers.byId[LAYER_ID];
  harness.setRectSelection = (x, y, w, h) => {
    const f = state.frames.byId[FRAME_ID];
    f.latestClipTool = 'rect';
    f.clipBoxes.rect = geometry.polygon.regularShapeToLocalPolygon('rect', geometry.asLocalRect({ x, y, w, h }));
  };
  harness.setLassoSelection = (points) => {
    const f = state.frames.byId[FRAME_ID];
    f.latestClipTool = 'lasso';
    f.clipBoxes.lasso = geometry.point2d.point2dToLocalPolygon([points], true);
  };

  return harness;
}

function bmask(overrides: Partial<BitmapMask> = {}): BitmapMask {
  return {
    id: 'bmask-1',
    src: 'data:,',
    assetId: 'asset-b',
    bounds: asLocalShape({ x: 0, y: 0, w: 100, h: 100 }, 'rect').rect as BitmapMask['bounds'],
    inverted: false,
    enabled: true,
    feather: 0,
    ...overrides,
  } as BitmapMask;
}


// ─── §8.1 Irregular Apply-Mask → path VectorMask ──────────────────────────────

describe('toMask — Apply-Mask VectorMask migration', () => {
  it('§8.1 lasso (irregular) selection → path VectorMask, no BitmapMask', async () => {
    const h = makeHarness();
    // Triangle: irregular → not recognized as rect/circle → path.
    h.setLassoSelection([{ x: 20, y: 20 }, { x: 60, y: 25 }, { x: 40, y: 70 }]);

    await LayerClipCommands.toMask.execute(h.ctx, {});

    const layer = h.layer();
    expect(layer.bitmapMasks).toEqual([]);            // no bitmap mask produced
    expect(layer.vectorMasks).toHaveLength(1);
    expect(layer.vectorMasks![0].shape.type).toBe('path');
    expect(layer.vectorMasks![0].inverted).toBe(false);
    expect(layer.vectorMasks![0].feather).toBe(0);
    expect(h.errorPulses).toBe(0);
  });

  it('§8.2 rect (regular) selection → rect VectorMask (zero regression)', async () => {
    const h = makeHarness();
    h.setRectSelection(10, 10, 30, 40);

    await LayerClipCommands.toMask.execute(h.ctx, {});

    const layer = h.layer();
    expect(layer.bitmapMasks).toEqual([]);
    expect(layer.vectorMasks).toHaveLength(1);
    expect(layer.vectorMasks![0].shape.type).toBe('rect');
    // Trunk layer (bounding == canvas, no pose) → frame-local == layer-local.
    expect(layer.vectorMasks![0].shape.rect).toMatchObject({ x: 10, y: 10, w: 30, h: 40 });
  });

  it('§8.2 ellipse (regular) selection → circle VectorMask', async () => {
    const h = makeHarness();
    const f = h.state.frames.byId[FRAME_ID];
    f.latestClipTool = 'ellipse';
    f.clipBoxes.ellipse = geometry.polygon.regularShapeToLocalPolygon('ellipse', geometry.asLocalRect({ x: 20, y: 20, w: 40, h: 40 }));

    await LayerClipCommands.toMask.execute(h.ctx, {});

    const layer = h.layer();
    expect(layer.bitmapMasks).toEqual([]);
    expect(layer.vectorMasks).toHaveLength(1);
    expect(layer.vectorMasks![0].shape.type).toBe('circle');
  });

  it('§8.3 posed layer (translated cx) → mask projected to layer-local (fixes 2.1)', async () => {
    // Layer translated by cx=20; bounding still == canvas so the pure translate
    // maps frame-local → layer-local by (-20, 0). The OLD regular branch fed the
    // frame-local shape straight to applyMask (no projection) → misaligned.
    const h = makeHarness({ cx: 20 });
    h.setRectSelection(10, 10, 30, 40);

    await LayerClipCommands.toMask.execute(h.ctx, {});

    const layer = h.layer();
    expect(layer.vectorMasks).toHaveLength(1);
    // Projection applied: x shifted by -20 vs the naive (buggy) frame-local x=10.
    expect(layer.vectorMasks![0].shape.rect.x).toBeCloseTo(-10, 5);
    expect(layer.vectorMasks![0].shape.rect.y).toBeCloseTo(10, 5);
  });

  it('§8.4 Apply-Mask (feather=0) → intersection is NOT degraded (geometric)', async () => {
    const h = makeHarness();
    h.setRectSelection(20, 20, 40, 40);
    await LayerClipCommands.toMask.execute(h.ctx, {});

    const layer = h.layer();
    const eff = getEffectiveVisibleShape(layer);
    expect(eff.degraded).toBe(false);

    // A subsequent cut selection intersects geometrically (non-null → not fallback).
    const sel = asLocalShape({ x: 30, y: 30, w: 10, h: 10 }, 'rect');
    expect(intersectWithLayer(sel, layer)).not.toBeNull();
  });

  it('§8.5 irregular + feather>0 → path VectorMask with feather (degrades in intersection)', async () => {
    const h = makeHarness();
    h.setLassoSelection([{ x: 20, y: 20 }, { x: 60, y: 25 }, { x: 40, y: 70 }]);

    await LayerClipCommands.toMask.execute(h.ctx, { feather: 5 });

    const layer = h.layer();
    expect(layer.bitmapMasks).toEqual([]);
    expect(layer.vectorMasks![0].shape.type).toBe('path');
    expect(layer.vectorMasks![0].feather).toBe(5);
    // feather>0 is a long-term capability boundary → still degraded (guardrail).
    expect(getEffectiveVisibleShape(layer).degraded).toBe(true);
  });

  it('§4.5 degenerate (collinear) selection → area guard early-out, error pulse, no mask', async () => {
    const h = makeHarness();
    // 3 collinear points → zero-height path.
    h.setLassoSelection([{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 30, y: 10 }]);

    await LayerClipCommands.toMask.execute(h.ctx, {});

    const layer = h.layer();
    expect(layer.vectorMasks).toEqual([]);
    expect(layer.bitmapMasks).toEqual([]);
    expect(h.errorPulses).toBe(1);
  });

  it('§4.5 empty rect selection → area guard early-out (regular branch now protected too)', async () => {
    const h = makeHarness();
    h.setRectSelection(10, 10, 0, 30); // zero width

    await LayerClipCommands.toMask.execute(h.ctx, {});

    const layer = h.layer();
    expect(layer.vectorMasks).toEqual([]);
    expect(h.errorPulses).toBe(1);
  });
});

// ─── §8.6 drill: legacy BitmapMask branch removed, vmask only ─────────────────

describe('drill — legacy BitmapMask branch removed', () => {
  it('§8.6 irregular drill → inverted path VectorMask, no BitmapMask', async () => {
    const h = makeHarness();
    h.setLassoSelection([{ x: 20, y: 20 }, { x: 60, y: 25 }, { x: 40, y: 70 }]);

    await LayerClipCommands.drill.execute(h.ctx, {});

    const layer = h.layer();
    expect(layer.bitmapMasks).toEqual([]);
    expect(layer.vectorMasks).toHaveLength(1);
    expect(layer.vectorMasks![0].shape.type).toBe('path');
    expect(layer.vectorMasks![0].inverted).toBe(true);
  });

  it('§8.6 regular drill → inverted rect VectorMask, no BitmapMask', async () => {
    const h = makeHarness();
    h.setRectSelection(10, 10, 30, 30);

    await LayerClipCommands.drill.execute(h.ctx, { feather: 3 });

    const layer = h.layer();
    expect(layer.bitmapMasks).toEqual([]);
    expect(layer.vectorMasks).toHaveLength(1);
    expect(layer.vectorMasks![0].shape.type).toBe('rect');
    expect(layer.vectorMasks![0].inverted).toBe(true);
    expect(layer.vectorMasks![0].feather).toBe(3);
  });

  it('drill outside clip mode is a no-op', async () => {
    const h = makeHarness();
    (h.ctx as unknown as { state: { interaction: { interactionMode: string } } }).state.interaction.interactionMode = 'pan';
    h.setRectSelection(10, 10, 30, 30);

    await LayerClipCommands.drill.execute(h.ctx, {});

    expect(h.layer().vectorMasks).toEqual([]);
  });
});

// ─── §8.7 / §8.8 BitmapMask infrastructure retained (eraser/legacy archives) ──

describe('BitmapMask infrastructure retained (not removed by this migration)', () => {
  it('§8.7 historical drilled BitmapMask is still consumed by the render fold (degraded → preserved)', () => {
    // A legacy archive layer carrying a tag:"drilled" bitmapMask must still be
    // recognized (degrade → mask consumed by the render path), never dropped.
    const layer = makeLayer({ bitmapMasks: [bmask({ id: 'bmask-drilled-1', tag: 'drilled' } as Partial<BitmapMask>)] });
    const eff = getEffectiveVisibleShape(layer);
    expect(eff.degraded).toBe(true);
  });

  it('§8.8 Apply-Mask path vmask + eraser bitmapMask coexist on one layer', async () => {
    const h = makeHarness();
    h.setLassoSelection([{ x: 20, y: 20 }, { x: 60, y: 25 }, { x: 40, y: 70 }]);
    await LayerClipCommands.toMask.execute(h.ctx, {});

    // Simulate an eraser stroke appending a BitmapMask afterwards.
    h.state.frames.byId[FRAME_ID].layers.byId[LAYER_ID] = {
      ...h.layer(),
      bitmapMasks: [bmask()],
    } as Layer;

    const layer = h.layer();
    expect(layer.vectorMasks).toHaveLength(1);
    expect(layer.vectorMasks![0].shape.type).toBe('path');
    expect(layer.bitmapMasks).toHaveLength(1);
    // Coexistence: bitmap present → render fold degrades (consumes bitmap mask).
    expect(getEffectiveVisibleShape(layer).degraded).toBe(true);
  });
});

