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
import { useEditorState, useEditorServices } from '@opengpex/editor/core/context';
import { Frame, Layer, AssetEntryInfo } from '@opengpex/editor/core/types';
import * as P from '../protocols';

/**
 * useAssetPool: Scans active frames to build asset usage map and active ID set.
 * Uses structuralSignature (frame/layer existence + assetId) to avoid
 * unnecessary re-computation on high-frequency property changes (opacity, visible, etc.).
 */
export const useAssetPool = (isEnabled: boolean, refreshKey: number) => {
  const { state } = useEditorState();
  const { assets } = useEditorServices();

  // Structural signature: only cares about frame/layer existence and assetId association
  // Does NOT include opacity, visible, locked, bounding — these change too frequently
  const structuralSignature = useMemo(() => {
    if (!isEnabled) return '';
    return state.frames.order.map(fid => {
      const f = state.frames.byId[fid];
      const layerIds = f.layers.order.map(lid => {
        const l = f.layers.byId[lid];
        return `${lid}:${l.assetId || ''}`;
      }).join(',');
      return `${fid}:${f.thumbnail?.assetId || ''}:${f.assetId || ''}[${layerIds}]`;
    }).join('|');
  }, [state.frames.order, state.frames.byId, isEnabled]);

  // Pool signature: only cares about asset count changes
  const poolSignature = useMemo(() => {
    if (!isEnabled) return '';
    const pool = assets.getPool();
    return `${Object.keys(pool).length}`;
  }, [assets, isEnabled]);

  // Full asset topology audit
  const result = useMemo(() => {
    if (!isEnabled || !structuralSignature) return null;

    console.log('🔍 [StorageInfo] Executing full asset topology audit - triggered by signature change...');
    const pool = assets.getPool();
    const usagesMap: Map<string, P.AssetUsage[]> = new Map();
    const tagsMap: Map<string, Set<P.AssetMetric['tags'][number]>> = new Map();

    const addUsage = (assetId: string, usage: P.AssetUsage, tag: P.AssetMetric['tags'][number]) => {
      if (!usagesMap.has(assetId)) usagesMap.set(assetId, []);
      usagesMap.get(assetId)!.push(usage);

      if (!tagsMap.has(assetId)) tagsMap.set(assetId, new Set());
      tagsMap.get(assetId)!.add(tag);
    };

    // Scan currently active frames
    const activeAssetIds = new Set<string>();

    state.frames.order.map(id => state.frames.byId[id]).forEach((f: Frame) => {
      if (f.thumbnail?.assetId) {
        activeAssetIds.add(f.thumbnail.assetId);
        addUsage(f.thumbnail.assetId, {
          assetId: f.thumbnail.assetId,
          source: 'thumbnail',
          frameId: f.id,
          frameName: f.name
        }, 'active');
      }
      // source asset (original imported file blob — prevent GC from reclaiming it)
      if (f.assetId) {
        activeAssetIds.add(f.assetId);
        addUsage(f.assetId, {
          assetId: f.assetId,
          source: 'layer',
          frameId: f.id,
          frameName: f.name,
          layerName: '(source file)'
        }, 'active');
      }
      f.layers.order.map(id => f.layers.byId[id]).forEach((l: Layer) => {
        if (l.assetId) {
          activeAssetIds.add(l.assetId);
          addUsage(l.assetId, {
            assetId: l.assetId,
            source: 'layer',
            frameId: f.id,
            frameName: f.name,
            layerName: l.name
          }, 'active');
        }
      });
    });

    const buildAssetMetric = (id: string, entry: AssetEntryInfo): P.AssetMetric => {
      const usages = usagesMap.get(id) || [];
      const tags: P.AssetMetric['tags'] = [];
      const tagSet = tagsMap.get(id) || new Set();

      if (tagSet.has('active')) tags.push('active');
      if (tagSet.has('history')) tags.push('history');

      const distinctFrames = new Set(usages.filter(u => u.frameId !== 'snapshot' && u.frameId !== 'system').map(u => u.frameId));
      if (distinctFrames.size > 1) tags.push('shared');

      return {
        id,
        blob: entry.blob,
        url: assets.getURL(id) || '',
        size: entry.blob.size,
        type: entry.blob.type,
        refCount: usages.length,
        usages,
        tags,
        tileMeta: entry.tileMeta as P.AssetMetric['tileMeta']
      };
    };

    return { pool, usagesMap, tagsMap, activeAssetIds, buildAssetMetric };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poolSignature and refreshKey are intentional invalidation triggers
  }, [isEnabled, structuralSignature, poolSignature, refreshKey, assets, state.frames.order, state.frames.byId]);

  return { assetPoolResult: result, structuralSignature };
};
