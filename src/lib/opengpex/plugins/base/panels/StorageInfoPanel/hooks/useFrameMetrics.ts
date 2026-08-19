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
import { AssetEntryInfo } from '@opengpex/editor/core/types';
import * as P from '../protocols';

interface AssetPoolResult {
  pool: Record<string, AssetEntryInfo>;
  usagesMap: Map<string, P.AssetUsage[]>;
  tagsMap: Map<string, Set<P.AssetMetric['tags'][number]>>;
  activeAssetIds: Set<string>;
  buildAssetMetric: (id: string, entry: AssetEntryInfo) => P.AssetMetric;
}

/**
 * useFrameMetrics: Builds FrameMetric[] from asset pool data and frame state.
 */
export const useFrameMetrics = (
  assetPoolResult: AssetPoolResult | null,
  structuralSignature: string
): P.FrameMetric[] => {
  const { state } = useEditorState();

  return useMemo(() => {
    if (!assetPoolResult || !structuralSignature) return [];

    const { pool, buildAssetMetric } = assetPoolResult;

    return state.frames.order.map(id => state.frames.byId[id]).map(f => {
      const thumbId = f.thumbnail?.assetId;
      const thumb = thumbId && pool[thumbId] ? buildAssetMetric(thumbId, pool[thumbId]) : undefined;

      const allLayerMetrics: Record<string, P.LayerMetric> = {};
      const subLayersMap: Record<string, P.LayerMetric[]> = {};

      f.layers.order.map(id => f.layers.byId[id]).forEach(l => {
        const asset = l.assetId && pool[l.assetId] ? buildAssetMetric(l.assetId, pool[l.assetId]) : undefined;

        const metric: P.LayerMetric = {
          id: l.id,
          name: l.name,
          type: l.type,
          visible: l.visible !== false,
          locked: l.locked === true,
          opacity: l.opacity ?? 100,
          bounding: l.bounding,
          asset,
          hostId: l.hostId,
          role: l.role
        };

        allLayerMetrics[l.id] = metric;

        if (l.hostId) {
          if (!subLayersMap[l.hostId]) subLayersMap[l.hostId] = [];
          subLayersMap[l.hostId].push(metric);
        }
      });

      const layers: P.LayerMetric[] = [];
      f.layers.order.forEach(id => {
        const metric = allLayerMetrics[id];
        if (metric && !metric.hostId) {
          metric.subLayers = subLayersMap[metric.id] || [];
          layers.push(metric);
        }
      });

      // Build source asset metric
      const srcId = f.assetId;
      const sourceAsset = srcId && pool[srcId] ? buildAssetMetric(srcId, pool[srcId]) : undefined;

      return {
        id: f.id,
        name: f.name,
        canvas: f.canvas,
        camera: f.camera,
        rotation: f.rotation || 0,
        thumbnail: thumb,
        sourceAsset,
        layers,
        historyCount: state.history.byFrameId[f.id]?.past?.length || 0,
        dpi: f.dpi,
        bitDepth: f.bitDepth,
        colorSpace: f.colorSpace,
        sourceFileName: f.metadata?.sourceFileName,
        sourceFormat: f.metadata?.sourceFormat,
      };
    });
  }, [assetPoolResult, structuralSignature, state.frames.order, state.frames.byId, state.history.byFrameId]);
};
