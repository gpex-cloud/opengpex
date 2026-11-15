/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useEditorState, useEditorServices } from '@opengpex/editor/core/context';
import { Hydrating } from '@opengpex/editor/core/storage/state/Hydrating';
import type { AssetStoreAuditEntry } from '@opengpex/editor/core/storage/asset/AssetService';
import * as P from '../protocols';

/**
 * useStoreAudit: STORE-level truth (IndexedDB), independent of the session
 * pool. Every persisted entry — display records AND the `raw:`/`dec:` heavy
 * payload keyspaces the pool never sees — is classified against the
 * document-referenced id set (frames + undo history, the same authority the
 * GC sweep uses):
 *   - `alive`   — referenced by the document state (or a system placeholder);
 *   - `orphan`  — stored but referenced by nothing (dead weight).
 * A `raw:` blob is alive when ANY referenced id carries its file-hash prefix
 * (`${fileHash}#${pageIndex}` ids share one physical source file);
 * `dec:` keys off the whole id exactly like the GC's protected-set scan.
 */
export const useStoreAudit = (isEnabled: boolean, refreshKey: number) => {
  const { state } = useEditorState();
  const { assets } = useEditorServices();
  const [entries, setEntries] = useState<AssetStoreAuditEntry[] | null>(null);
  const [isAuditing, setIsAuditing] = useState(false);

  const runAudit = useCallback(async () => {
    setIsAuditing(true);
    try {
      setEntries(await assets.auditStore());
    } catch (err) {
      console.warn('[StorageInfo] Store audit failed:', err);
      setEntries([]);
    } finally {
      setIsAuditing(false);
    }
  }, [assets]);

  useEffect(() => {
    // When disabled the summary already resolves to null (the isEnabled gate
    // in the useMemo below) — no state reset needed here; re-enabling simply
    // re-runs the audit through the refreshKey/isEnabled dependencies. The
    // zero-delay kick avoids a synchronous setState inside the effect body.
    if (!isEnabled) return;
    const kick = setTimeout(() => void runAudit(), 0);
    return () => clearTimeout(kick);
  }, [isEnabled, refreshKey, runAudit]);

  const summary = useMemo<P.StoreAuditSummary | null>(() => {
    if (!isEnabled || entries === null) return null;

    // Document-referenced id set (frames + history) — mirrors StateStorage.gc.
    const referenced = Hydrating.extractAllIds({ frames: state.frames, history: state.history });

    // File hashes protected by any referenced id: `raw:` keys off the
    // `${fileHash}#${pageIndex}` id's `#` prefix.
    const protectedFileHashes = new Set<string>();
    for (const id of referenced) {
      protectedFileHashes.add(id.split('#')[0]);
    }

    const SYSTEM_PLACEHOLDER_ID = 'asset-transparent-pixel';
    const isAlive = (entry: AssetStoreAuditEntry): boolean => {
      if (entry.kind === 'raw') return protectedFileHashes.has(entry.key.slice(4));
      // `dec:` keys off the WHOLE bare asset id — strip the prefix before
      // testing the referenced set (the engine's protected-set scan does the same).
      if (entry.kind === 'dec') return referenced.has(entry.key.slice(4));
      return referenced.has(entry.key) || entry.key === SYSTEM_PLACEHOLDER_ID;
    };

    const classified: P.StoreAuditEntryView[] = entries.map((e) => ({ ...e, alive: isAlive(e) }));
    const orphans = classified.filter((e) => !e.alive);
    const totalBytes = classified.reduce((s, e) => s + Math.max(0, e.size), 0);
    const aliveBytes = classified.reduce((s, e) => (e.alive ? s + Math.max(0, e.size) : s), 0);

    return {
      entries: classified,
      totalBytes,
      aliveBytes,
      orphanBytes: totalBytes - aliveBytes,
      orphanCount: orphans.length,
      displayCount: classified.filter((e) => e.kind === 'display').length,
      rawCount: classified.filter((e) => e.kind === 'raw').length,
      decCount: classified.filter((e) => e.kind === 'dec').length,
      orphans,
    };
  }, [isEnabled, entries, state.frames, state.history]);

  return { storeAudit: summary, isAuditing, rerunAudit: runAudit };
};
