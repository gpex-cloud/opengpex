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
