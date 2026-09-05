import { describe, it, expect } from 'vitest';
import { LayerFactory } from './factory';
import { VectorMask, BitmapMask, asLocalShape, asLocalRect, type Frame, type Layer } from '@opengpex/editor/core/types';

describe('LayerFactory.cleanInheritedMasks', () => {
  it('returns empty array when input is undefined or empty', () => {
    expect(LayerFactory.cleanInheritedMasks()).toEqual([]);
    expect(LayerFactory.cleanInheritedMasks([])).toEqual([]);
  });

  it('filters out reserved masks for VectorMask', () => {
    const masks: VectorMask[] = [
      {
        id: 'mask-reserved',
        shape: asLocalShape({ x: 0, y: 0, w: 10, h: 10 }),
        inverted: false,
        feather: 0,
        enabled: true,
        reserved: true,
      },
      {
        id: 'mask-normal',
        shape: asLocalShape({ x: 0, y: 0, w: 20, h: 20 }),
        inverted: false,
        feather: 0,
        enabled: true,
      },
    ];

    const cleaned = LayerFactory.cleanInheritedMasks(masks);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].id).toMatch(/^mask-inherited-/);
  });

  it('strips assocLayerId from hole masks and assigns new unique id', () => {
    const masks: VectorMask[] = [
      {
        id: 'mask-hole-layer-b',
        shape: asLocalShape({ x: 50, y: 50, w: 100, h: 100 }),
        inverted: true,
        feather: 0,
        enabled: true,
        assocLayerId: 'layer-b',
      },
    ];

    const cleaned = LayerFactory.cleanInheritedMasks(masks);
    expect(cleaned).toHaveLength(1);
    expect((cleaned[0] as VectorMask).assocLayerId).toBeUndefined();
    expect(cleaned[0].id).not.toBe('mask-hole-layer-b');
    expect(cleaned[0].id).toMatch(/^mask-inherited-/);
    expect(cleaned[0].inverted).toBe(true);
    expect((cleaned[0] as VectorMask).shape).toEqual(asLocalShape({ x: 50, y: 50, w: 100, h: 100 }));
  });

  it('assigns fresh ids with bmask prefix for BitmapMask', () => {
    const masks: BitmapMask[] = [
      {
        id: 'bmask-source-1',
        src: 'blob:test',
        assetId: 'asset-test-1',
        bounds: asLocalRect({ x: 0, y: 0, w: 100, h: 100 }),
        inverted: false,
        enabled: true,
        feather: 0,
      },
    ];

    const cleaned = LayerFactory.cleanInheritedMasks(masks);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].id).not.toBe('bmask-source-1');
    expect(cleaned[0].id).toMatch(/^bmask-inherited-/);
    expect(cleaned[0].assetId).toBe('asset-test-1');
    expect(cleaned[0].bounds).toEqual(asLocalRect({ x: 0, y: 0, w: 100, h: 100 }));
  });

  it('assigns fresh ids with bmask prefix even when assetId is absent on BitmapMask', () => {
    const masks: BitmapMask[] = [
      {
        id: 'bmask-mock',
        src: '',
        assetId: '',
        bounds: asLocalRect({ x: 10, y: 10, w: 50, h: 50 }),
        inverted: false,
        enabled: true,
        feather: 0,
      },
    ];

    const cleaned = LayerFactory.cleanInheritedMasks(masks);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].id).toMatch(/^bmask-inherited-/);
  });
});

describe('LayerFactory.getInsertIndexAbove', () => {
  it('returns undefined if targetLayerId is not provided or not found', () => {
    const mockFrame = {
      id: 'f1',
      layers: {
        order: ['l1', 'l2'],
        byId: {
          l1: { id: 'l1' } as unknown as Layer,
          l2: { id: 'l2' } as unknown as Layer,
        },
      },
    } as unknown as Frame;

    expect(LayerFactory.getInsertIndexAbove(mockFrame)).toBeUndefined();
    expect(LayerFactory.getInsertIndexAbove(mockFrame, 'non-existent')).toBeUndefined();
  });

  it('returns targetIdx + 1 for normal layers without children', () => {
    const mockFrame = {
      id: 'f1',
      layers: {
        order: ['l1', 'l2', 'l3'],
        byId: {
          l1: { id: 'l1' } as unknown as Layer,
          l2: { id: 'l2' } as unknown as Layer,
          l3: { id: 'l3' } as unknown as Layer,
        },
      },
    } as unknown as Frame;

    expect(LayerFactory.getInsertIndexAbove(mockFrame, 'l1')).toBe(1);
    expect(LayerFactory.getInsertIndexAbove(mockFrame, 'l2')).toBe(2);
    expect(LayerFactory.getInsertIndexAbove(mockFrame, 'l3')).toBe(3);
  });

  it('skips past child sublayers (hostId match) of the target layer', () => {
    const mockFrame = {
      id: 'f1',
      layers: {
        order: ['l1', 'l1-child1', 'l1-child2', 'l2'],
        byId: {
          l1: { id: 'l1' } as unknown as Layer,
          'l1-child1': { id: 'l1-child1', hostId: 'l1' } as unknown as Layer,
          'l1-child2': { id: 'l1-child2', hostId: 'l1' } as unknown as Layer,
          l2: { id: 'l2' } as unknown as Layer,
        },
      },
    } as unknown as Frame;

    expect(LayerFactory.getInsertIndexAbove(mockFrame, 'l1')).toBe(3);
  });

  it('inserts above the highest child when target is a group layer', () => {
    const mockFrame = {
      id: 'f1',
      layers: {
        order: ['g1', 'c1', 'c2', 'l_outside'],
        byId: {
          g1: { id: 'g1', type: 'group' } as unknown as Layer,
          c1: { id: 'c1', groupId: 'g1' } as unknown as Layer,
          c2: { id: 'c2', groupId: 'g1' } as unknown as Layer,
          l_outside: { id: 'l_outside' } as unknown as Layer,
        },
      },
    } as unknown as Frame;

    // Highest child is c2 at index 2, so inserting above group inserts at index 3
    expect(LayerFactory.getInsertIndexAbove(mockFrame, 'g1')).toBe(3);
  });
});

// Shared predicates matching the Text/Marker tool usage of resolveNeighborGroupTarget.
const isText = (l: Layer | null | undefined) => !!l && l.type === 'text';
const isTextGroup = (l: Layer | null | undefined) =>
  !!l && l.type === 'group' && (l as Layer).metadata?.isTextGroup === true;

describe('LayerFactory.resolveActiveHostLayer', () => {
  it('returns null when there is no active selection', () => {
    const frame = {
      activeLayerId: null,
      layers: { order: ['l1'], byId: { l1: { id: 'l1' } as unknown as Layer } },
    } as unknown as Frame;
    expect(LayerFactory.resolveActiveHostLayer(frame)).toBeNull();
  });

  it('returns the active host layer directly', () => {
    const l1 = { id: 'l1' } as unknown as Layer;
    const frame = {
      activeLayerId: 'l1',
      layers: { order: ['l1'], byId: { l1 } },
    } as unknown as Frame;
    expect(LayerFactory.resolveActiveHostLayer(frame)).toBe(l1);
  });

  it('resolves an active triplet sub-layer (hostId) up to its host', () => {
    const host = { id: 'host' } as unknown as Layer;
    const sub = { id: 'sub', hostId: 'host' } as unknown as Layer;
    const frame = {
      activeLayerId: 'sub',
      layers: { order: ['host', 'sub'], byId: { host, sub } },
    } as unknown as Frame;
    expect(LayerFactory.resolveActiveHostLayer(frame)).toBe(host);
  });
});

describe('LayerFactory.resolveHostAbove', () => {
  const l1 = { id: 'l1' } as unknown as Layer;
  const l2 = { id: 'l2' } as unknown as Layer;
  const frame = {
    layers: { order: ['l1', 'l2'], byId: { l1, l2 } },
  } as unknown as Frame;

  it('returns null for undefined slot (push-to-top) and for a top-of-stack slot', () => {
    expect(LayerFactory.resolveHostAbove(frame, undefined)).toBeNull();
    expect(LayerFactory.resolveHostAbove(frame, 2)).toBeNull();
  });

  it('returns the host at the slot', () => {
    expect(LayerFactory.resolveHostAbove(frame, 1)).toBe(l2);
  });

  it('resolves a triplet sub-layer at the slot up to its host', () => {
    const host = { id: 'host' } as unknown as Layer;
    const sub = { id: 'sub', hostId: 'host' } as unknown as Layer;
    const f = {
      layers: { order: ['host', 'sub'], byId: { host, sub } },
    } as unknown as Frame;
    expect(LayerFactory.resolveHostAbove(f, 1)).toBe(host);
  });
});

describe('LayerFactory.resolveNeighborGroupTarget', () => {
  const predicates = { isMember: isText, isGroupHeader: isTextGroup };
  const run = (frame: Frame, below: Layer | null, above: Layer | null) =>
    LayerFactory.resolveNeighborGroupTarget(frame, below, above, predicates);
  const emptyFrame = { layers: { order: [], byId: {} } } as unknown as Frame;

  it("both neighbours irrelevant → 'none'", () => {
    expect(run(emptyFrame, null, null)).toEqual({ mode: 'none' });
    const img = { id: 'img', type: 'image' } as unknown as Layer;
    expect(run(emptyFrame, img, img)).toEqual({ mode: 'none' });
  });

  it("below is a bare text → 'create' (below wins, above never consulted)", () => {
    const t1 = { id: 't1', type: 'text' } as unknown as Layer;
    const gAbove = { id: 'g', type: 'group', metadata: { isTextGroup: true } } as unknown as Layer;
    const frame = { layers: { order: ['t1', 'g'], byId: { t1, g: gAbove } } } as unknown as Frame;
    expect(run(frame, t1, gAbove)).toEqual({ mode: 'create', seedLayerId: 't1' });
  });

  it("below irrelevant, above is a bare text → 'create' via above neighbour", () => {
    const img = { id: 'img', type: 'image' } as unknown as Layer;
    const t1 = { id: 't1', type: 'text' } as unknown as Layer;
    const frame = { layers: { order: ['img', 't1'], byId: { img, t1 } } } as unknown as Frame;
    expect(run(frame, img, t1)).toEqual({ mode: 'create', seedLayerId: 't1' });
  });

  it("neighbour is a text-group header → 'append'", () => {
    const g = { id: 'g', type: 'group', metadata: { isTextGroup: true } } as unknown as Layer;
    const frame = { layers: { order: ['g'], byId: { g } } } as unknown as Frame;
    expect(run(frame, g, null)).toEqual({ mode: 'append', groupId: 'g' });
  });

  it("neighbour is a text already inside a text group → 'append' (via groupId)", () => {
    const g = { id: 'g', type: 'group', metadata: { isTextGroup: true } } as unknown as Layer;
    const t1 = { id: 't1', type: 'text', groupId: 'g' } as unknown as Layer;
    const frame = { layers: { order: ['t1', 'g'], byId: { t1, g } } } as unknown as Frame;
    expect(run(frame, t1, null)).toEqual({ mode: 'append', groupId: 'g' });
  });

  it("neighbour text inside a MANUAL (non-text) group → 'none' (respects manual grouping)", () => {
    const g = { id: 'g', type: 'group', metadata: {} } as unknown as Layer;
    const t1 = { id: 't1', type: 'text', groupId: 'g' } as unknown as Layer;
    const frame = { layers: { order: ['t1', 'g'], byId: { t1, g } } } as unknown as Frame;
    expect(run(frame, t1, null)).toEqual({ mode: 'none' });
  });

  it('injected predicates isolate kinds: a vector group is not a text target → falls through to above', () => {
    const gm = { id: 'gm', type: 'group', metadata: { isVectorGroup: true } } as unknown as Layer;
    const t1 = { id: 't1', type: 'text' } as unknown as Layer;
    const frame = { layers: { order: ['gm', 't1'], byId: { gm, t1 } } } as unknown as Frame;
    // below (vector group) is irrelevant for text predicates → above bare text seeds.
    expect(run(frame, gm, t1)).toEqual({ mode: 'create', seedLayerId: 't1' });
  });
});
