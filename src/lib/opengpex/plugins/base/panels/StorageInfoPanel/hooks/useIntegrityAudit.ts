/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

'use client';

import { useMemo } from 'react';
import { useEditorState } from '@opengpex/editor/core/context';
import type { NormalizedState, Frame } from '@opengpex/editor/core/types';

/**
 * Structural integrity audit of the in-memory document state.
 *
 * Diagnostics only — reports, never repairs. The panel renders the findings
 * so a corrupted persisted document (e.g. a `frames.order` that kept two
 * entries for one id after the pre-fix same-millisecond frame-id collision)
 * becomes visible instead of surfacing only as React duplicate-key warnings.
 */

export interface IntegrityFinding {
  /** Stable machine key, one finding kind per structural rule. */
  kind:
    | 'duplicate-frame-order'
    | 'dangling-frame-order'
    | 'duplicate-layer-order'
    | 'dangling-layer-order'
    | 'dangling-history-frame';
  /** Human-readable one-liner describing the rule that failed. */
  label: string;
  /** Display rows, one per offending id (duplicate entries carry an "x2" hint). */
  items: string[];
}

export interface IntegrityReport {
  /** True when every structural rule passed. */
  ok: boolean;
  findings: IntegrityFinding[];
}

/**
 * Id FORMAT is deliberately not a finding: a pre-collision-fix id without a
 * random segment is harmless as long as it is unique — only actual
 * duplication (or dangling references) corrupts document state.
 */

/** Collect ids that appear more than once in an order array ("id (xN)"). */
function findOrderDuplicates(order: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const id of order) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([id, n]) => `${id} (x${n})`);
}

/** Order entries with no matching byId record ("id (dangling)"). */
function findDangling(order: readonly string[], byId: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of order) {
    if (!byId[id] && !seen.has(id)) {
      seen.add(id);
      out.push(`${id} (dangling)`);
    }
  }
  return out;
}

/**
 * useIntegrityAudit: memoized structural scan of frames, per-frame layer
 * collections, and the per-frame history map. Stable identity while the
 * scanned structures are unchanged, so the memoized panel does not churn.
 */
export function useIntegrityAudit(): IntegrityReport {
  const { state } = useEditorState();
  const { order, byId } = state.frames;
  const { byFrameId } = state.history;

  return useMemo<IntegrityReport>(() => {
    const findings: IntegrityFinding[] = [];

    const dupFrames = findOrderDuplicates(order);
    if (dupFrames.length > 0) {
      findings.push({
        kind: 'duplicate-frame-order',
        label: 'Frame order entries duplicated (React duplicate-key source)',
        items: dupFrames,
      });
    }

    const danglingFrames = findDangling(order, byId);
    if (danglingFrames.length > 0) {
      findings.push({
        kind: 'dangling-frame-order',
        label: 'Frame order entries without a frame record',
        items: danglingFrames,
      });
    }

    // Per-frame layer scans — iterate unique frame records only, so a
    // duplicated order entry does not report the same layers twice.
    const visited = new Set<string>();
    const dupLayers: string[] = [];
    const danglingLayers: string[] = [];
    order.forEach((fid) => {
      const frame: Frame | undefined = byId[fid];
      if (!frame || visited.has(fid)) return;
      visited.add(fid);
      const layerStore: NormalizedState<unknown> = frame.layers;
      for (const dup of findOrderDuplicates(layerStore.order)) dupLayers.push(`${fid} → ${dup}`);
      for (const dangle of findDangling(layerStore.order, layerStore.byId)) danglingLayers.push(`${fid} → ${dangle}`);
    });
    if (dupLayers.length > 0) {
      findings.push({ kind: 'duplicate-layer-order', label: 'Layer order entries duplicated inside a frame', items: dupLayers });
    }
    if (danglingLayers.length > 0) {
      findings.push({ kind: 'dangling-layer-order', label: 'Layer order entries without a layer record', items: danglingLayers });
    }

    const danglingHistory = Object.keys(byFrameId)
      .filter((fid) => byId[fid] === undefined)
      .map((fid) => `${fid} (dangling)`);
    if (danglingHistory.length > 0) {
      findings.push({
        kind: 'dangling-history-frame',
        label: 'History stacks keyed by a frame that no longer exists',
        items: danglingHistory,
      });
    }

    return { ok: findings.length === 0, findings };
  }, [order, byId, byFrameId]);
}
