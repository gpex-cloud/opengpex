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
 * Cut-Link Association & Logical Merge Tests
 *
 * Tests for the Cut Link feature:
 * - Bidirectional pointer establishment (cut mode)
 * - Lineage-only pointer (copy mode)
 * - MergeBack recursive behavior
 * - Auto-cleanup and degradation logic
 *
 * @see docs/opengpex/plans/20260823_cut_link_and_logical_merge_spec.md
 */

import { describe, it, expect } from 'vitest';
import { LayerFactory } from '../../factory';
import type { Layer, VectorMask, Frame } from '@opengpex/editor/core/types/models';
import type { LocalShape } from '@opengpex/editor/core/types/primitives';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLocalShape(x = 10, y = 10, w = 50, h = 50): LocalShape {
  return {
    type: 'rect',
    rect: { x, y, w, h },
    hardEdge: false,
    __brand: 'local',
  } as LocalShape;
}

function makeLayer(id: string, overrides?: Partial<Layer>): Layer {
  return LayerFactory.getNewLayer({
    id,
    name: `Layer ${id}`,
    type: 'image',
    src: 'test.png',
    assetId: 'asset-test',
    bounding: { w: 100, h: 100 },
    ...overrides,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 1: Data Model Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('VectorMask assocLayerId', () => {
  it('should create mask without assocLayerId by default', () => {
    const shape = makeLocalShape();
    const mask = LayerFactory.getNewVectorMask(shape, { inverted: true });
    expect(mask.assocLayerId).toBeUndefined();
    expect(mask.id).toMatch(/^mask-rect-/);
  });

  it('should create mask with custom id and assocLayerId when provided', () => {
    const shape = makeLocalShape();
    const mask = LayerFactory.getNewVectorMask(shape, { inverted: true, assocLayerId: 'layer-B', maskId: 'mask-hole-layer-B' });
    expect(mask.id).toBe('mask-hole-layer-B');
    expect(mask.assocLayerId).toBe('layer-B');
    expect(mask.inverted).toBe(true);
    expect(mask.feather).toBe(0);
    expect(mask.enabled).toBe(true);
  });

  it('should not set assocLayerId when assocLayerId is undefined', () => {
    const shape = makeLocalShape();
    const mask = LayerFactory.getNewVectorMask(shape, { feather: 2, maskId: 'custom-id' });
    expect(mask.id).toBe('custom-id');
    expect(mask.assocLayerId).toBeUndefined();
  });
});

describe('Layer metadata sourceLayerId / assocMaskId', () => {
  it('should support sourceLayerId and assocMaskId in layer metadata', () => {
    const layer = makeLayer('frag-1', {
      metadata: {
        sourceLayerId: 'source-A',
        assocMaskId: 'mask-hole-frag-1',
        clipTool: 'rect',
      },
    });
    expect(layer.metadata?.sourceLayerId).toBe('source-A');
    expect(layer.metadata?.assocMaskId).toBe('mask-hole-frag-1');
    expect(layer.metadata?.clipTool).toBe('rect');
  });

  it('copy mode: should have sourceLayerId but no assocMaskId', () => {
    const layer = makeLayer('copy-1', {
      metadata: { sourceLayerId: 'source-A' },
    });
    expect(layer.metadata?.sourceLayerId).toBe('source-A');
    expect(layer.metadata?.assocMaskId).toBeUndefined();
  });

  it('independent layer: no sourceLayerId', () => {
    const layer = makeLayer('independent');
    // metadata may or may not be defined, but sourceLayerId is not set
    expect(layer.metadata?.sourceLayerId).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cut-Link Relationship Integrity
// ═══════════════════════════════════════════════════════════════════════════════

describe('Cut-Link bidirectional pointers', () => {
  it('should establish correct bidirectional relationship', () => {
    // Simulate what fragment.ts produces for cut mode:
    const sourceLayerId = 'layer-A';
    const fragmentLayerId = 'layer-B';
    const holeMaskId = `mask-hole-${fragmentLayerId}`;

    // Source layer gets a hole mask with assocLayerId
    const holeMask = LayerFactory.getNewVectorMask(makeLocalShape(), { inverted: true, assocLayerId: fragmentLayerId, maskId: holeMaskId });

    // Fragment layer gets metadata pointing back
    const fragmentLayer = makeLayer(fragmentLayerId, {
      metadata: {
        sourceLayerId,
        assocMaskId: holeMaskId,
      },
    });

    // Verify bidirectional pointers
    expect(holeMask.id).toBe(holeMaskId);
    expect(holeMask.assocLayerId).toBe(fragmentLayerId);
    expect(fragmentLayer.metadata?.sourceLayerId).toBe(sourceLayerId);
    expect(fragmentLayer.metadata?.assocMaskId).toBe(holeMaskId);

    // Verify the deterministic naming convention
    expect(holeMaskId).toBe(`mask-hole-${fragmentLayerId}`);
  });

  it('should identify cut fragment vs copy vs independent', () => {
    const cutFragment = makeLayer('cut', {
      metadata: { sourceLayerId: 'A', assocMaskId: 'mask-hole-cut' },
    });
    const copyDerived = makeLayer('copy', {
      metadata: { sourceLayerId: 'A' },
    });
    const independent = makeLayer('ind');

    // Cut fragment: both sourceLayerId and assocMaskId present
    const isCut = !!(cutFragment.metadata?.sourceLayerId && cutFragment.metadata?.assocMaskId);
    expect(isCut).toBe(true);

    // Copy derived: sourceLayerId present, no assocMaskId
    const isCopy = !!(copyDerived.metadata?.sourceLayerId && !copyDerived.metadata?.assocMaskId);
    expect(isCopy).toBe(true);

    // Independent: no sourceLayerId
    const isInd = !independent.metadata?.sourceLayerId;
    expect(isInd).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Merge Back Logic (Unit — pure logic tests without full context)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Merge Back recursive behavior', () => {
  it('should identify downstream fragments for a given layer', () => {
    // Scenario: A → B → D (A cuts to B, B cuts to D)
    const layerA = makeLayer('A', { vectorMasks: [
      LayerFactory.getNewVectorMask(makeLocalShape(), { inverted: true, assocLayerId: 'B', maskId: 'mask-hole-B' }),
    ] });
    const layerB = makeLayer('B', {
      metadata: { sourceLayerId: 'A', assocMaskId: 'mask-hole-B' },
      vectorMasks: [
        LayerFactory.getNewVectorMask(makeLocalShape(20, 20, 30, 30), { inverted: true, assocLayerId: 'D', maskId: 'mask-hole-D' }),
      ],
    });
    const layerD = makeLayer('D', {
      metadata: { sourceLayerId: 'B', assocMaskId: 'mask-hole-D' },
    });

    const allLayers = [layerA, layerB, layerD];

    // Find downstream fragments of B
    const downstreamOfB = allLayers.filter(l =>
      l.metadata?.sourceLayerId === 'B' && l.metadata?.assocMaskId
    );
    expect(downstreamOfB).toHaveLength(1);
    expect(downstreamOfB[0].id).toBe('D');

    // Find downstream fragments of A
    const downstreamOfA = allLayers.filter(l =>
      l.metadata?.sourceLayerId === 'A' && l.metadata?.assocMaskId
    );
    expect(downstreamOfA).toHaveLength(1);
    expect(downstreamOfA[0].id).toBe('B');

    // D has no downstream
    const downstreamOfD = allLayers.filter(l =>
      l.metadata?.sourceLayerId === 'D' && l.metadata?.assocMaskId
    );
    expect(downstreamOfD).toHaveLength(0);
  });

  it('should detect source layer with hole masks', () => {
    const sourceLayer = makeLayer('A', {
      vectorMasks: [
        LayerFactory.getNewVectorMask(makeLocalShape(), { inverted: true, assocLayerId: 'B', maskId: 'mask-hole-B' }),
        LayerFactory.getNewVectorMask(makeLocalShape(60, 60, 30, 30), { inverted: true, assocLayerId: 'C', maskId: 'mask-hole-C' }),
        LayerFactory.getNewVectorMask(makeLocalShape(0, 0, 100, 100)), // regular mask, no assocLayerId
      ],
    });

    const hasHoleMasks = sourceLayer.vectorMasks?.some(m => m.assocLayerId);
    expect(hasHoleMasks).toBe(true);

    const holeMasks = sourceLayer.vectorMasks?.filter(m => m.assocLayerId);
    expect(holeMasks).toHaveLength(2);
    expect(holeMasks![0].assocLayerId).toBe('B');
    expect(holeMasks![1].assocLayerId).toBe('C');
  });

  it('merge back should remove hole mask from source', () => {
    // Simulate merge back of fragment B from source A
    const sourceVectorMasks: VectorMask[] = [
      LayerFactory.getNewVectorMask(makeLocalShape(), { inverted: true, assocLayerId: 'B', maskId: 'mask-hole-B' }),
      LayerFactory.getNewVectorMask(makeLocalShape(60, 60, 30, 30), { inverted: true, assocLayerId: 'C', maskId: 'mask-hole-C' }),
    ];

    const assocMaskId = 'mask-hole-B';
    const afterMerge = sourceVectorMasks.filter(m => m.id !== assocMaskId);

    expect(afterMerge).toHaveLength(1);
    expect(afterMerge[0].id).toBe('mask-hole-C');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Auto-cleanup and Degradation Logic
// ═══════════════════════════════════════════════════════════════════════════════

describe('Auto-cleanup: delete fragment → remove hole mask', () => {
  it('should identify that deleting a fragment requires removing its hole mask', () => {
    const fragmentLayer = makeLayer('B', {
      metadata: { sourceLayerId: 'A', assocMaskId: 'mask-hole-B' },
    });

    // Logic that removeLayers would perform:
    const sourceLayerId = fragmentLayer.metadata?.sourceLayerId as string;
    const assocMaskId = fragmentLayer.metadata?.assocMaskId as string;

    expect(sourceLayerId).toBe('A');
    expect(assocMaskId).toBe('mask-hole-B');

    // The hole mask on source layer should be removed
    const sourceMasks: VectorMask[] = [
      LayerFactory.getNewVectorMask(makeLocalShape(), { inverted: true, assocLayerId: 'B', maskId: 'mask-hole-B' }),
    ];
    const afterCleanup = sourceMasks.filter(m => m.id !== assocMaskId);
    expect(afterCleanup).toHaveLength(0);
  });
});

describe('Degradation: delete hole mask → clear fragment assocMaskId', () => {
  it('should degrade cut to copy when hole mask is manually removed', () => {
    // When a hole mask with assocLayerId is removed,
    // the fragment layer's assocMaskId should be cleared
    const holeMask = LayerFactory.getNewVectorMask(makeLocalShape(), {
      inverted: true, assocLayerId: 'B', maskId: 'mask-hole-B',
    });

    expect(holeMask.assocLayerId).toBe('B');

    // After removing the mask, fragment B should lose its assocMaskId:
    const fragmentMeta = {
      sourceLayerId: 'A',
      assocMaskId: 'mask-hole-B',
      clipTool: 'rect',
    };

    // Simulate degradation: remove assocMaskId but keep sourceLayerId
    const { assocMaskId: _, ...degradedMeta } = fragmentMeta;
    expect(degradedMeta.sourceLayerId).toBe('A');
    expect(degradedMeta.clipTool).toBe('rect');
    expect('assocMaskId' in degradedMeta).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('Edge cases', () => {
  it('should handle source layer deletion gracefully (dangling reference)', () => {
    // Fragment with sourceLayerId pointing to a deleted layer
    const fragment = makeLayer('orphan-frag', {
      metadata: { sourceLayerId: 'deleted-layer', assocMaskId: 'mask-hole-orphan-frag' },
    });

    // The fragment still renders correctly even if source is gone
    expect(fragment.metadata?.sourceLayerId).toBe('deleted-layer');
    // Merge Back should be a no-op if source doesn't exist (checked at runtime)
  });

  it('should not merge back a copy-only layer (no assocMaskId)', () => {
    const copyLayer = makeLayer('copy-layer', {
      metadata: { sourceLayerId: 'A' },
    });

    const canMergeBack = !!(copyLayer.metadata?.sourceLayerId && copyLayer.metadata?.assocMaskId);
    expect(canMergeBack).toBe(false);
  });

  it('mask id naming convention is deterministic', () => {
    const layerIds = ['l-abc123', 'l-xyz789', 'layer-test'];
    for (const id of layerIds) {
      const maskId = `mask-hole-${id}`;
      expect(maskId).toContain(id);
      expect(maskId.startsWith('mask-hole-')).toBe(true);
    }
  });
});
