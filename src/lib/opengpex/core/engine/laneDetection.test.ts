/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * PixelService.render.detectLane — pure lane dispatch tests.
 *
 * Covers §7.2 of docs/opengpex/20260710_rendering_and_export_pipeline_overview.md.
 * Runs in vitest with no browser APIs required.
 */

import { describe, it, expect } from 'vitest';
import { detectLane, type Lane } from './laneDetection';
import type { Frame, LocalShape, RenderToBlobOptions } from '@opengpex/editor/core/types';

// ─── Helpers ───────────────────────────────────────────────────────────────

interface MockLayerParams {
  id: string;
  assetId?: string;
  visible?: boolean;
  hostId?: string;
  bitDepth?: number;
}

function mockLayer(p: MockLayerParams) {
  return {
    id: p.id,
    assetId: p.assetId,
    visible: p.visible !== false,
    hostId: p.hostId,
    metadata: p.bitDepth ? { imageMetadata: { bitDepth: p.bitDepth } } : undefined,
  };
}

function mockFrame(layers: MockLayerParams[], canvasW = 1000, canvasH = 800): Frame {
  const byId: Record<string, unknown> = {};
  const order: string[] = [];
  for (const p of layers) {
    byId[p.id] = mockLayer(p);
    order.push(p.id);
  }
  return {
    id: 'f1',
    name: 'test',
    canvas: { w: canvasW, h: canvasH },
    dpi: 72,
    layers: { byId, order },
  } as unknown as Frame;
}

function fullRectShape(frame: Frame): LocalShape {
  return {
    __brand: 'local',
    type: 'rect',
    rect: { __brand: 'local', x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h },
    hardEdge: false,
  } as unknown as LocalShape;
}

function polygonShape(): LocalShape {
  return {
    __brand: 'local',
    type: 'polygon',
    rings: [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]],
  } as unknown as LocalShape;
}

const alwaysTrue = async (_id: string) => true;
const alwaysFalse = async (_id: string) => false;
const only = (ids: string[]) => async (id: string) => ids.includes(id);

async function expectLane(
  frame: Frame,
  shape: LocalShape,
  opts: RenderToBlobOptions,
  probe: (id: string) => Promise<boolean> | boolean,
  expected: Lane,
) {
  const actual = await detectLane(frame, shape, opts, probe);
  expect(actual).toBe(expected);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('detectLane — fast path', () => {
  it('format="raw" → lane-c (cache warmup path)', async () => {
    const frame = mockFrame([{ id: 'l1', assetId: 'a1', bitDepth: 16 }]);
    await expectLane(frame, fullRectShape(frame), { format: 'raw' }, alwaysTrue, 'lane-c');
  });
});

describe('detectLane — 8-bit requests always → lane-c', () => {
  it('exportBitDepth=8 → lane-c even with raw available', async () => {
    const frame = mockFrame([{ id: 'l1', assetId: 'a1', bitDepth: 16 }]);
    await expectLane(
      frame, fullRectShape(frame),
      { format: 'image/tiff', exportBitDepth: 8 }, alwaysTrue, 'lane-c',
    );
  });

  it('exportBitDepth undefined → lane-c', async () => {
    const frame = mockFrame([{ id: 'l1', assetId: 'a1', bitDepth: 16 }]);
    await expectLane(frame, fullRectShape(frame), { format: 'image/tiff' }, alwaysTrue, 'lane-c');
  });
});

describe('detectLane — unsupported vips format → lane-c', () => {
  it('JPEG + exportBitDepth=16 → lane-c (JPEG can\'t hold 16-bit)', async () => {
    const frame = mockFrame([{ id: 'l1', assetId: 'a1', bitDepth: 16 }]);
    await expectLane(
      frame, fullRectShape(frame),
      { format: 'image/jpeg', exportBitDepth: 16 }, alwaysTrue, 'lane-c',
    );
  });

  it('WebP + exportBitDepth=16 → lane-c', async () => {
    const frame = mockFrame([{ id: 'l1', assetId: 'a1', bitDepth: 16 }]);
    await expectLane(
      frame, fullRectShape(frame),
      { format: 'image/webp', exportBitDepth: 16 }, alwaysTrue, 'lane-c',
    );
  });

  it('AVIF + exportBitDepth=16 → lane-c', async () => {
    const frame = mockFrame([{ id: 'l1', assetId: 'a1', bitDepth: 16 }]);
    await expectLane(
      frame, fullRectShape(frame),
      { format: 'image/avif', exportBitDepth: 16 }, alwaysTrue, 'lane-c',
    );
  });
});

describe('detectLane — non-rect shape → lane-c (16-bit downgrade already handled upstream, but safety net here)', () => {
  it('polygon shape + 16-bit TIFF → lane-c', async () => {
    const frame = mockFrame([{ id: 'l1', assetId: 'a1', bitDepth: 16 }]);
    await expectLane(
      frame, polygonShape(),
      { format: 'image/tiff', exportBitDepth: 16 }, alwaysTrue, 'lane-c',
    );
  });
});

describe('detectLane — empty / hidden layers → lane-c', () => {
  it('no visible layers → lane-c', async () => {
    const frame = mockFrame([{ id: 'l1', assetId: 'a1', bitDepth: 16, visible: false }]);
    await expectLane(
      frame, fullRectShape(frame),
      { format: 'image/tiff', exportBitDepth: 16 }, alwaysTrue, 'lane-c',
    );
  });

  it('host layers are skipped', async () => {
    const frame = mockFrame([
      { id: 'host', hostId: undefined, assetId: 'a1', bitDepth: 16 },
      { id: 'child', hostId: 'host', assetId: 'a1', bitDepth: 16 },
    ]);
    // "host" layers are those with no hostId. Only 1 top-level → lane-a.
    await expectLane(
      frame, fullRectShape(frame),
      { format: 'image/tiff', exportBitDepth: 16 }, alwaysTrue, 'lane-a',
    );
  });
});

describe('detectLane — Lane A eligibility (single-layer 16-bit direct)', () => {
  it('single 16-bit layer with hasRaw + TIFF → lane-a', async () => {
    const frame = mockFrame([{ id: 'l1', assetId: 'a1', bitDepth: 16 }]);
    await expectLane(
      frame, fullRectShape(frame),
      { format: 'image/tiff', exportBitDepth: 16 }, alwaysTrue, 'lane-a',
    );
  });

  it('single 16-bit layer with hasRaw + PNG → lane-a', async () => {
    const frame = mockFrame([{ id: 'l1', assetId: 'a1', bitDepth: 16 }]);
    await expectLane(
      frame, fullRectShape(frame),
      { format: 'image/png', exportBitDepth: 16 }, alwaysTrue, 'lane-a',
    );
  });

  it('single layer bitDepth=8 with hasRaw → falls through to lane-b (vips upcasts 8→16 during composite)', async () => {
    // Lane A strictly requires bitDepth > 8. But an 8-bit source with raw is still valid for 16-bit
    // output via Lane B, which will upcast to ushort inside vips before composite. So we expect lane-b.
    const frame = mockFrame([{ id: 'l1', assetId: 'a1', bitDepth: 8 }]);
    await expectLane(
      frame, fullRectShape(frame),
      { format: 'image/tiff', exportBitDepth: 16 }, alwaysTrue, 'lane-b',
    );
  });

  it('single layer bitDepth=8 without hasRaw → lane-c', async () => {
    const frame = mockFrame([{ id: 'l1', assetId: 'a1', bitDepth: 8 }]);
    await expectLane(
      frame, fullRectShape(frame),
      { format: 'image/tiff', exportBitDepth: 16 }, alwaysFalse, 'lane-c',
    );
  });


  it('single 16-bit layer but no raw source → lane-c', async () => {
    const frame = mockFrame([{ id: 'l1', assetId: 'a1', bitDepth: 16 }]);
    await expectLane(
      frame, fullRectShape(frame),
      { format: 'image/tiff', exportBitDepth: 16 }, alwaysFalse, 'lane-c',
    );
  });

  it('single 16-bit layer without assetId → lane-c', async () => {
    const frame = mockFrame([{ id: 'l1', assetId: undefined, bitDepth: 16 }]);
    await expectLane(
      frame, fullRectShape(frame),
      { format: 'image/tiff', exportBitDepth: 16 }, alwaysTrue, 'lane-c',
    );
  });

  it('single layer missing bitDepth metadata (defaults to 8) but hasRaw → lane-b (upcast)', async () => {
    // No bitDepth in metadata → default 8, so Lane A rejects. But hasRaw=true means Lane B accepts.
    const frame = mockFrame([{ id: 'l1', assetId: 'a1' /* no bitDepth */ }]);
    await expectLane(
      frame, fullRectShape(frame),
      { format: 'image/tiff', exportBitDepth: 16 }, alwaysTrue, 'lane-b',
    );
  });

});

describe('detectLane — Lane B eligibility (multi-layer 16-bit composite)', () => {
  it('two 16-bit layers both with raw → lane-b', async () => {
    const frame = mockFrame([
      { id: 'l1', assetId: 'a1', bitDepth: 16 },
      { id: 'l2', assetId: 'a2', bitDepth: 16 },
    ]);
    await expectLane(
      frame, fullRectShape(frame),
      { format: 'image/tiff', exportBitDepth: 16 }, alwaysTrue, 'lane-b',
    );
  });

  it('mixed 16-bit + 8-bit, only 16-bit has raw → lane-b', async () => {
    const frame = mockFrame([
      { id: 'l1', assetId: 'a1', bitDepth: 16 },
      { id: 'l2', assetId: 'a2', bitDepth: 8 },
    ]);
    await expectLane(
      frame, fullRectShape(frame),
      { format: 'image/tiff', exportBitDepth: 16 }, only(['a1']), 'lane-b',
    );
  });

  it('two layers, none have raw → lane-c', async () => {
    const frame = mockFrame([
      { id: 'l1', assetId: 'a1', bitDepth: 16 },
      { id: 'l2', assetId: 'a2', bitDepth: 8 },
    ]);
    await expectLane(
      frame, fullRectShape(frame),
      { format: 'image/tiff', exportBitDepth: 16 }, alwaysFalse, 'lane-c',
    );
  });

  it('layers without assetId are skipped (no raw probe possible)', async () => {
    const frame = mockFrame([
      { id: 'l1', assetId: undefined },
      { id: 'l2', assetId: undefined },
    ]);
    await expectLane(
      frame, fullRectShape(frame),
      { format: 'image/tiff', exportBitDepth: 16 }, alwaysTrue, 'lane-c',
    );
  });
});

describe('detectLane — check ordering / determinism', () => {
  it('is deterministic across calls with the same inputs', async () => {
    const frame = mockFrame([{ id: 'l1', assetId: 'a1', bitDepth: 16 }]);
    const shape = fullRectShape(frame);
    const opts: RenderToBlobOptions = { format: 'image/tiff', exportBitDepth: 16 };
    const a = await detectLane(frame, shape, opts, alwaysTrue);
    const b = await detectLane(frame, shape, opts, alwaysTrue);
    expect(a).toBe(b);
  });

  it('lane-a check has priority over lane-b when single visible layer', async () => {
    // Only l1 is visible; l2 is hidden.
    const frame = mockFrame([
      { id: 'l1', assetId: 'a1', bitDepth: 16 },
      { id: 'l2', assetId: 'a2', bitDepth: 16, visible: false },
    ]);
    await expectLane(
      frame, fullRectShape(frame),
      { format: 'image/tiff', exportBitDepth: 16 }, alwaysTrue, 'lane-a',
    );
  });
});
