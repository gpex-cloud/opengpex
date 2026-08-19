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

import { useMemo } from 'react';
import { useEditorState } from '@opengpex/editor/core/context';
import * as P from '../protocols';

/**
 * useShardMetrics: Simulates IndexedDB shard physical sizes.
 * Re-computes when frame structure changes.
 */
export const useShardMetrics = (isEnabled: boolean, structuralSignature: string) => {
  const { state } = useEditorState();

  return useMemo(() => {
    if (!isEnabled || !structuralSignature) return { shards: [] as P.DBShardMetric[], stateBytes: 0 };

    const shards: P.DBShardMetric[] = [];
    let stateBytes = 0;

    // A. project_meta
    const metaObj = {
      activeFrameId: state.activeFrameId,
      frameIds: state.frames.order,
      version: '5.0',
      timestamp: 1718448000000 // Stable timestamp for pure render calculation
    };
    const metaStr = JSON.stringify(metaObj);
    shards.push({ key: 'project_meta', type: 'project_meta', sizeBytes: metaStr.length });
    stateBytes += metaStr.length;

    // B. frame shards
    state.frames.order.forEach(fid => {
      const f = state.frames.byId[fid];
      const shardedFrame = {
        ...f,
        layers: {
          ...f.layers,
          byId: Object.fromEntries(
            Object.entries(f.layers.byId).map(([lid, l]) => [
              lid,
              { ...l, src: '' }
            ])
          )
        }
      };
      const frameStr = JSON.stringify(shardedFrame);
      shards.push({ key: `frame:${fid}`, type: 'frame', sizeBytes: frameStr.length });
      stateBytes += frameStr.length;
    });

    // C. history_index (per-frame map)
    const historyStr = JSON.stringify(state.history.byFrameId);
    shards.push({ key: 'history_index', type: 'history_index', sizeBytes: historyStr.length });
    stateBytes += historyStr.length;

    return { shards, stateBytes };
  }, [isEnabled, structuralSignature, state.activeFrameId, state.frames.order, state.frames.byId, state.history.byFrameId]);
};
