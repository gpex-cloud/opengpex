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
 * MarkerOverlay auto-group — decision-logic invariant suite.
 *
 * Symmetric to TextOverlay's text-auto-group suite. Guards the consecutive-marker
 * auto-grouping routed through MarkerOverlay's `cmd.place` (see commands.ts
 * `resolveGrouping`). Both the new-layer landing spot and the grouping decision
 * are anchored on the ACTIVE layer (the reference host layer the new marker lands
 * directly on top of), NOT the absolute stack top — Photoshop-style "insert above
 * the selected layer". Same none/create/append modes, same dual check on both the
 * group header AND a marker's `groupId` so the header's flat-order position is
 * irrelevant.
 *
 * Kept deliberately separate from TextOverlay's auto-group: markers use the
 * `isVectorGroup` flag, so text and marker never fold into the same group.
 */

import { describe, it, expect } from 'vitest';

type Grouping =
  | { mode: 'none' }
  | { mode: 'append'; groupId: string }
  | { mode: 'create'; seedLayerId: string };

interface TestLayer {
  id: string;
  type: 'text' | 'image' | 'vector' | 'group';
  hostId?: string;
  groupId?: string;
  markerData?: Record<string, unknown>;
  metadata?: { isTextGroup?: boolean; isVectorGroup?: boolean };
}

interface TestFrame {
  layers: { order: string[]; byId: Record<string, TestLayer> };
  activeLayerId?: string | null;
}

/** Build a frame from a top-down panel listing (index 0 = bottom of z-order). */
function makeFrame(layers: TestLayer[], activeLayerId?: string | null): TestFrame {
  const byId: Record<string, TestLayer> = {};
  for (const l of layers) byId[l.id] = l;
  return { layers: { order: layers.map(l => l.id), byId }, activeLayerId: activeLayerId ?? null };
}

// ─── Mirror of commands.ts (production logic) ─────────────────────────────────

function isMarkerLayer(l: TestLayer | undefined | null): boolean {
  return !!l && l.type === 'vector' && !!l.markerData;
}

function isVectorGroup(l: TestLayer | undefined | null): boolean {
  return !!l && l.type === 'group' && l.metadata?.isVectorGroup === true;
}

/** Mirror of resolveReferenceHostLayer: active layer, resolved to its host. */
function resolveReferenceHostLayer(frame: TestFrame): TestLayer | null {
  const activeId = frame.activeLayerId;
  if (!activeId) return null;
  const layer = frame.layers.byId[activeId];
  if (!layer) return null;
  if (layer.hostId) return frame.layers.byId[layer.hostId] ?? null;
  return layer;
}

/** Mirror of resolveHostAbove: host directly above the insertion slot. */
function resolveHostAbove(frame: TestFrame, insertAt: number | undefined): TestLayer | null {
  if (typeof insertAt !== 'number') return null;
  const order = frame.layers.order;
  if (insertAt >= order.length) return null;
  const l = frame.layers.byId[order[insertAt]];
  if (!l) return null;
  return l.hostId ? (frame.layers.byId[l.hostId] ?? null) : l;
}

type MarkerTarget = { kind: 'group'; groupId: string } | { kind: 'seed'; seedId: string } | null;

/** Mirror of classifyMarkerTarget. */
function classifyMarkerTarget(frame: TestFrame, layer: TestLayer | null): MarkerTarget {
  if (!layer) return null;
  if (isVectorGroup(layer)) return { kind: 'group', groupId: layer.id };
  if (isMarkerLayer(layer)) {
    if (layer.groupId) {
      const g = frame.layers.byId[layer.groupId];
      return isVectorGroup(g) ? { kind: 'group', groupId: g.id } : null;
    }
    return { kind: 'seed', seedId: layer.id };
  }
  return null;
}

/** Mirror of resolveGrouping: below neighbour first, then above neighbour. */
function resolveGrouping(frame: TestFrame, below: TestLayer | null, above: TestLayer | null): Grouping {
  const b = classifyMarkerTarget(frame, below);
  if (b?.kind === 'group') return { mode: 'append', groupId: b.groupId };
  if (b?.kind === 'seed') return { mode: 'create', seedLayerId: b.seedId };

  const a = classifyMarkerTarget(frame, above);
  if (a?.kind === 'group') return { mode: 'append', groupId: a.groupId };
  if (a?.kind === 'seed') return { mode: 'create', seedLayerId: a.seedId };

  return { mode: 'none' };
}

/** Mirror of LayerFactory.getInsertIndexAbove. */
function getInsertIndexAbove(frame: TestFrame, targetLayerId?: string | null): number | undefined {
  if (!targetLayerId) return undefined;
  const order = frame.layers.order;
  const targetIdx = order.indexOf(targetLayerId);
  if (targetIdx < 0) return undefined;

  const targetLayer = frame.layers.byId[targetLayerId];
  if (targetLayer?.type === 'group') {
    let topChildIdx = targetIdx;
    for (let i = order.length - 1; i > targetIdx; i--) {
      if (frame.layers.byId[order[i]]?.groupId === targetLayerId) { topChildIdx = i; break; }
    }
    let insertAt = topChildIdx + 1;
    const topId = order[topChildIdx];
    while (insertAt < order.length && frame.layers.byId[order[insertAt]]?.hostId === topId) insertAt++;
    return insertAt;
  }

  let insertAt = targetIdx + 1;
  while (insertAt < order.length && frame.layers.byId[order[insertAt]]?.hostId === targetLayerId) insertAt++;
  return insertAt;
}

// ─── Mirror of the full cmd.place placement (z-order + active tracking) ────────

function place(frame: TestFrame, newId: string): TestFrame {
  const below = resolveReferenceHostLayer(frame);
  const insertAt = getInsertIndexAbove(frame, below?.id);
  const above = resolveHostAbove(frame, insertAt);
  const decision = resolveGrouping(frame, below, above);

  const order = [...frame.layers.order];
  const byId: Record<string, TestLayer> = {};
  for (const id of order) byId[id] = { ...frame.layers.byId[id] };

  const marker = (): TestLayer => ({ id: newId, type: 'vector', markerData: {} });
  const insertOrPush = (id: string, layer: TestLayer, index: number | undefined) => {
    byId[id] = layer;
    if (typeof index === 'number') order.splice(index, 0, id);
    else order.push(id);
  };

  if (decision.mode === 'append') {
    const groupInsertAt = getInsertIndexAbove({ layers: { order, byId } }, decision.groupId);
    insertOrPush(newId, { ...marker(), groupId: decision.groupId }, groupInsertAt);
    return { layers: { order, byId }, activeLayerId: newId };
  }

  if (decision.mode === 'create') {
    const seedId = decision.seedLayerId;
    const groupId = `g-${newId}`;

    byId[seedId] = { ...byId[seedId], groupId };
    const seedIdx = order.indexOf(seedId);
    const headerIndex = Math.min(seedIdx, insertAt as number);
    byId[groupId] = { id: groupId, type: 'group', metadata: { isVectorGroup: true } };
    order.splice(headerIndex, 0, groupId);   // header at bottom of the combined block

    insertOrPush(newId, { ...marker(), groupId }, (insertAt as number) + 1);
    return { layers: { order, byId }, activeLayerId: newId };
  }

  insertOrPush(newId, marker(), insertAt);
  return { layers: { order, byId }, activeLayerId: newId };
}

describe('MarkerOverlay auto-group — placement lands above the active layer', () => {
  it('inserts a plain marker directly above a mid-stack active image (not at the top)', () => {
    let frame = makeFrame([
      { id: 'img', type: 'image' },
      { id: 'mid', type: 'image' },
      { id: 'top', type: 'image' },
    ], 'mid');
    frame = place(frame, 'm1');
    expect(frame.layers.order).toEqual(['img', 'mid', 'm1', 'top']);
    expect(frame.layers.byId['m1'].groupId).toBeUndefined();
  });

  it('append lands the new marker directly above the group, below an unrelated top layer', () => {
    let frame = makeFrame([
      { id: 'g', type: 'group', metadata: { isVectorGroup: true } },
      { id: 'm1', type: 'vector', markerData: {}, groupId: 'g' },
      { id: 'top', type: 'image' },
    ], 'g');
    frame = place(frame, 'm2');
    expect(frame.layers.order).toEqual(['g', 'm1', 'm2', 'top']);
    expect(frame.layers.byId['m2'].groupId).toBe('g');
  });

  it('create via below neighbour: new marker directly above the seed, header just below it', () => {
    let frame = makeFrame([
      { id: 'img', type: 'image' },
      { id: 'm1', type: 'vector', markerData: {} },
      { id: 'top', type: 'image' },
    ], 'm1');
    frame = place(frame, 'm2');
    expect(frame.layers.order).toEqual(['img', 'g-m2', 'm1', 'm2', 'top']);
    expect(frame.layers.byId['m1'].groupId).toBe('g-m2');
    expect(frame.layers.byId['m2'].groupId).toBe('g-m2');
    expect(frame.layers.byId['g-m2'].metadata?.isVectorGroup).toBe(true);
  });

  it('create via ABOVE neighbour: header below the block, new marker under the pre-existing marker', () => {
    let frame = makeFrame([
      { id: 'img', type: 'image' },
      { id: 'mid', type: 'image' },
      { id: 'm1', type: 'vector', markerData: {} },
    ], 'mid');
    frame = place(frame, 'm2');
    // bottom→top: img, mid, header, m2, m1.
    expect(frame.layers.order).toEqual(['img', 'mid', 'g-m2', 'm2', 'm1']);
    expect(frame.layers.byId['m1'].groupId).toBe('g-m2');
    expect(frame.layers.byId['m2'].groupId).toBe('g-m2');
    expect(frame.layers.order.indexOf('g-m2')).toBe(frame.layers.order.indexOf('m2') - 1);
  });
});

describe('MarkerOverlay auto-group — z-order after consecutive placement', () => {
  it('m1 → m2 → m3 lands them in one group, newest on top (panel top→bottom: m3, m2, m1)', () => {
    let frame = makeFrame([]);
    frame = place(frame, 'm1');   // none → plain layer (active m1)
    frame = place(frame, 'm2');   // create → group with m1 (seed) + m2
    frame = place(frame, 'm3');   // append → into the same group

    const g1 = frame.layers.byId['m1'].groupId;
    expect(g1).toBeTruthy();
    expect(frame.layers.byId['m2'].groupId).toBe(g1);
    expect(frame.layers.byId['m3'].groupId).toBe(g1);
    expect(frame.layers.byId[g1!].metadata?.isVectorGroup).toBe(true);

    const topToBottom = [...frame.layers.order].reverse();
    const children = topToBottom.filter(id => frame.layers.byId[id].groupId === g1);
    expect(children).toEqual(['m3', 'm2', 'm1']);
    expect(topToBottom.indexOf(g1!)).toBe(topToBottom.indexOf('m1') + 1);
  });

  it('does not create a group when placing a single marker on an image', () => {
    let frame = makeFrame([{ id: 'img', type: 'image' }], 'img');
    frame = place(frame, 'm1');
    expect(frame.layers.byId['m1'].groupId).toBeUndefined();
    expect(Object.values(frame.layers.byId).some(l => l.type === 'group')).toBe(false);
  });

  it('selecting a lower image whose ABOVE neighbour is a vector group → appends into that group', () => {
    let frame = makeFrame([{ id: 'img', type: 'image' }], 'img');
    frame = place(frame, 'm1');
    frame = place(frame, 'm2');   // m1+m2 grouped
    const g = frame.layers.byId['m1'].groupId!;

    frame = { ...frame, activeLayerId: 'img' };
    frame = place(frame, 'm3');

    expect(frame.layers.byId['m3'].groupId).toBe(g);
  });

  it('selecting a lower image with a NON-marker layer above → no merge, plain insert', () => {
    let frame = makeFrame([
      { id: 'img', type: 'image' },
      { id: 'cover', type: 'image' },
    ], 'img');
    frame = place(frame, 'm1');
    expect(frame.layers.byId['m1'].groupId).toBeUndefined();
    expect(Object.values(frame.layers.byId).some(l => l.type === 'group')).toBe(false);
    expect(frame.layers.order).toEqual(['img', 'm1', 'cover']);
  });
});

