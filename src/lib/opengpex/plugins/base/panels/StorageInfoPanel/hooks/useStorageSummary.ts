/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

'use client';

import { useMemo, useState, useCallback } from 'react';
import { useStorageConfig } from './useStorageConfig';
import { useAssetPool } from './useAssetPool';
import { useFrameMetrics } from './useFrameMetrics';
import { useHistoryMetrics } from './useHistoryMetrics';
import { useShardMetrics } from './useShardMetrics';
import * as P from '../protocols';

/**
 * useStorageMetrics: Combines all sub-hooks into a single StorageSummary.
 * This is the main entry point replacing the original monolithic hook.
 */
export const useStorageMetrics = () => {
  const { isEnabled } = useStorageConfig();

  // Manual refresh mechanism
  const [refreshKey, setRefreshKey] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refresh = useCallback(() => {
    if (!isEnabled) return;
    setIsRefreshing(true);
    setTimeout(() => {
      setRefreshKey(prev => prev + 1);
      setIsRefreshing(false);
    }, 400);
  }, [isEnabled]);

  // Sync state during render
  if (isEnabled && refreshKey === 0) {
    setRefreshKey(1);
  } else if (!isEnabled && refreshKey !== 0) {
    setRefreshKey(0);
  }

  // Compose sub-hooks
  const { assetPoolResult, structuralSignature } = useAssetPool(isEnabled, refreshKey);
  const frames = useFrameMetrics(assetPoolResult, structuralSignature);
  const history = useHistoryMetrics(isEnabled);
  const { shards, stateBytes } = useShardMetrics(isEnabled, structuralSignature);

  // Combine into final summary
  const summary = useMemo<P.StorageSummary | null>(() => {
    if (!isEnabled || !assetPoolResult) return null;

    const { pool, activeAssetIds, buildAssetMetric } = assetPoolResult;

    const detached: P.AssetMetric[] = Object.entries(pool)
      .filter(([id]) => !activeAssetIds.has(id))
      .map(([id, entry]) => buildAssetMetric(id, entry))
      .sort((a, b) => b.size - a.size);

    return {
      totalBytes: Object.values(pool).reduce((sum, entry) => sum + entry.blob.size, 0),
      assetCount: Object.keys(pool).length,
      stateBytes,
      shards,
      frames,
      history,
      detached
    };
  }, [isEnabled, assetPoolResult, frames, history, shards, stateBytes]);

  return { summary, refresh, isRefreshing };
};
