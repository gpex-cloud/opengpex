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
 * TextOverlay auto-group — decision-logic invariant suite.
 *
 * Guards the consecutive-text auto-grouping routed through TextOverlay's
 * `cmd.place` (see commands.ts `resolveGrouping`). The helpers below mirror the
 * production decision exactly — the new-layer landing spot and the grouping
 * decision are both anchored on the ACTIVE layer (the reference host layer the
 * new text lands directly on top of), NOT the absolute stack top. Same
 * none/create/append modes, same dual check on both the group header AND a text
 * layer's `groupId` so the header's position in the flat order is irrelevant.
 *
 * Kept deliberately separate from MarkerOverlay's auto-group: text uses the
 * `isTextGroup` flag, so text and marker never fold into the same group.
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

function isTextLayer(l: TestLayer | undefined | null): boolean {
  return !!l && l.type === 'text';
}

function isTextGroup(l: TestLayer | undefined | null): boolean {
  return !!l && l.type === 'group' && l.metadata?.isTextGroup === true;
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

type TextTarget = { kind: 'group'; groupId: string } | { kind: 'seed'; seedId: string } | null;

/** Mirror of classifyTextTarget. */
function classifyTextTarget(frame: TestFrame, layer: TestLayer | null): TextTarget {
  if (!layer) return null;
  if (isTextGroup(layer)) return { kind: 'group', groupId: layer.id };
  if (isTextLayer(layer)) {
    if (layer.groupId) {
      const g = frame.layers.byId[layer.groupId];
      return isTextGroup(g) ? { kind: 'group', groupId: g.id } : null;
    }
    return { kind: 'seed', seedId: layer.id };
  }
  return null;
}

/** Mirror of resolveGrouping: below neighbour first, then above neighbour. */
function resolveGrouping(frame: TestFrame, below: TestLayer | null, above: TestLayer | null): Grouping {
  const b = classifyTextTarget(frame, below);
  if (b?.kind === 'group') return { mode: 'append', groupId: b.groupId };
  if (b?.kind === 'seed') return { mode: 'create', seedLayerId: b.seedId };

  const a = classifyTextTarget(frame, above);
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
//
// Reproduces cmd.place against the "insert above active layer, group with nearest
// text neighbour" model:
//   - below   = active layer (host-resolved); insertAt = getInsertIndexAbove(below);
//   - above   = host layer directly above the slot;
//   - decision = resolveGrouping(below, above);
//   - 'none'   → insert at insertAt (or push when undefined);
//   - 'append' → insert at getInsertIndexAbove(group) (top of member block);
//   - 'create' → header at min(seedIdx, insertAt), new text at insertAt + 1.
// After every placement the new text becomes the active layer (finishPlace).

function place(frame: TestFrame, newId: string): TestFrame {
  const below = resolveReferenceHostLayer(frame);
  const insertAt = getInsertIndexAbove(frame, below?.id);
  const above = resolveHostAbove(frame, insertAt);
  const decision = resolveGrouping(frame, below, above);

  const order = [...frame.layers.order];
  const byId: Record<string, TestLayer> = {};
  for (const id of order) byId[id] = { ...frame.layers.byId[id] };

  const insertOrPush = (id: string, layer: TestLayer, index: number | undefined) => {
    byId[id] = layer;
    if (typeof index === 'number') order.splice(index, 0, id);
    else order.push(id);
  };

  if (decision.mode === 'append') {
    const groupInsertAt = getInsertIndexAbove({ layers: { order, byId } }, decision.groupId);
    insertOrPush(newId, { id: newId, type: 'text', groupId: decision.groupId }, groupInsertAt);
    return { layers: { order, byId }, activeLayerId: newId };
  }

  if (decision.mode === 'create') {
    const seedId = decision.seedLayerId;
    const groupId = `g-${newId}`;

    byId[seedId] = { ...byId[seedId], groupId };
    const seedIdx = order.indexOf(seedId);
    const headerIndex = Math.min(seedIdx, insertAt as number);
    byId[groupId] = { id: groupId, type: 'group', metadata: { isTextGroup: true } };
    order.splice(headerIndex, 0, groupId);   // header at bottom of the combined block

    insertOrPush(newId, { id: newId, type: 'text', groupId }, (insertAt as number) + 1);
    return { layers: { order, byId }, activeLayerId: newId };
  }

  insertOrPush(newId, { id: newId, type: 'text' }, insertAt);
  return { layers: { order, byId }, activeLayerId: newId };
}

describe('TextOverlay auto-group — placement lands above the active layer', () => {
  it('inserts a plain text directly above a mid-stack active image (not at the top)', () => {
    let frame = makeFrame([
      { id: 'img', type: 'image' },
      { id: 'mid', type: 'image' },
      { id: 'top', type: 'image' },
    ], 'mid');
    frame = place(frame, 't1');
    // t1 sits directly above 'mid', below 'top' — not pushed to the absolute top.
    expect(frame.layers.order).toEqual(['img', 'mid', 't1', 'top']);
    expect(frame.layers.byId['t1'].groupId).toBeUndefined();
  });

  it('append lands the new text directly above the group, below an unrelated top layer', () => {
    let frame = makeFrame([
      { id: 'g', type: 'group', metadata: { isTextGroup: true } },
      { id: 't1', type: 'text', groupId: 'g' },
      { id: 'top', type: 'image' },
    ], 'g');
    frame = place(frame, 't2');
    // t2 appended above the group's highest child (t1), still under 'top'.
    expect(frame.layers.order).toEqual(['g', 't1', 't2', 'top']);
    expect(frame.layers.byId['t2'].groupId).toBe('g');
  });

  it('create via below neighbour: new text directly above the seed, header just below it', () => {
    let frame = makeFrame([
      { id: 'img', type: 'image' },
      { id: 't1', type: 'text' },
      { id: 'top', type: 'image' },
    ], 't1');
    frame = place(frame, 't2');
    // Header just below t1, t2 directly above t1, 'top' untouched at the top.
    expect(frame.layers.order).toEqual(['img', 'g-t2', 't1', 't2', 'top']);
    expect(frame.layers.byId['t1'].groupId).toBe('g-t2');
    expect(frame.layers.byId['t2'].groupId).toBe('g-t2');
    expect(frame.layers.byId['g-t2'].metadata?.isTextGroup).toBe(true);
  });

  it('create via ABOVE neighbour: header below the block, new text under the pre-existing text', () => {
    // Active is the image 'mid'; the text 't1' sits directly above the slot.
    let frame = makeFrame([
      { id: 'img', type: 'image' },
      { id: 'mid', type: 'image' },
      { id: 't1', type: 'text' },
    ], 'mid');
    frame = place(frame, 't2');
    // Slot is above 'mid' (index 2). Header goes to bottom of {t2,t1} block, new
    // text lands just below the pre-existing t1, above the active image.
    // bottom→top: img, mid, header, t2, t1.
    expect(frame.layers.order).toEqual(['img', 'mid', 'g-t2', 't2', 't1']);
    expect(frame.layers.byId['t1'].groupId).toBe('g-t2');
    expect(frame.layers.byId['t2'].groupId).toBe('g-t2');
    // Header is at the bottom of the member block (spec §2.2): just below t2.
    expect(frame.layers.order.indexOf('g-t2')).toBe(frame.layers.order.indexOf('t2') - 1);
  });
});

describe('TextOverlay auto-group — z-order after consecutive placement', () => {
  it('t1 → t2 → t3 lands them in one group, newest on top (panel top→bottom: t3, t2, t1)', () => {
    let frame = makeFrame([]);
    frame = place(frame, 't1');   // none → plain layer (active becomes t1)
    frame = place(frame, 't2');   // create → group with t1 (seed) + t2 (active t1)
    frame = place(frame, 't3');   // append → into the same group (active t2)

    // Every text layer shares one text group.
    const g1 = frame.layers.byId['t1'].groupId;
    expect(g1).toBeTruthy();
    expect(frame.layers.byId['t2'].groupId).toBe(g1);
    expect(frame.layers.byId['t3'].groupId).toBe(g1);
    expect(frame.layers.byId[g1!].metadata?.isTextGroup).toBe(true);

    // Panel order is top→bottom = order reversed. Children newest-first: t3, t2, t1;
    // the group header sits at the bottom of the member block.
    const topToBottom = [...frame.layers.order].reverse();
    const children = topToBottom.filter(id => frame.layers.byId[id].groupId === g1);
    expect(children).toEqual(['t3', 't2', 't1']);
    // Header is the last of the block (bottom), i.e. below t1 in panel terms.
    expect(topToBottom.indexOf(g1!)).toBe(topToBottom.indexOf('t1') + 1);
  });

  it('does not create a group when placing a single text on an image', () => {
    let frame = makeFrame([{ id: 'img', type: 'image' }], 'img');
    frame = place(frame, 't1');
    expect(frame.layers.byId['t1'].groupId).toBeUndefined();
    expect(Object.values(frame.layers.byId).some(l => l.type === 'group')).toBe(false);
  });

  it('selecting a lower image whose ABOVE neighbour is a text group → appends into that group', () => {
    // Build t1+t2 into a text group above an image, then select the image.
    let frame = makeFrame([{ id: 'img', type: 'image' }], 'img');
    frame = place(frame, 't1');   // t1 above img (active t1)
    frame = place(frame, 't2');   // t1+t2 grouped (active t2 in group)
    const g = frame.layers.byId['t1'].groupId!;

    // User clicks the bottom image → active 'img'. The slot above it is the group.
    frame = { ...frame, activeLayerId: 'img' };
    frame = place(frame, 't3');

    // Nearest neighbour above the slot is the group → t3 joins it (newest on top).
    expect(frame.layers.byId['t3'].groupId).toBe(g);
  });

  it('selecting a lower image with a NON-text layer above → no merge, plain insert', () => {
    // img (active) → someImage above → nothing text-related on either side.
    let frame = makeFrame([
      { id: 'img', type: 'image' },
      { id: 'cover', type: 'image' },
    ], 'img');
    frame = place(frame, 't1');
    expect(frame.layers.byId['t1'].groupId).toBeUndefined();
    expect(Object.values(frame.layers.byId).some(l => l.type === 'group')).toBe(false);
    // Lands directly above the active image, below 'cover'.
    expect(frame.layers.order).toEqual(['img', 't1', 'cover']);
  });
});

