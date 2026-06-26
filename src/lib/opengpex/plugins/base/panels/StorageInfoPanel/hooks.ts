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

'use client';

import { useMemo, useState, useCallback, useEffect } from 'react';
import { useEditorState, useEditorServices, usePluginSelfConfig, usePluginCommands } from '@opengpex/editor/core/context';
import { Frame, Layer, AssetEntryInfo } from '@opengpex/editor/core/types';
import * as P from './protocols';

/**
 * Shape of frame-like data within history snapshots (serialized/legacy format).
 * Snapshots may store layers as plain arrays rather than NormalizedState.
 */
interface SnapshotFrameData {
  id?: string;
  name?: string;
  thumbnail?: { assetId?: string };
  thumbnailAssetId?: string;
  layers?: { assetId?: string; name?: string }[];
}

/**
 * Shape of history snapshot content for storage audit purposes.
 * May contain a `frames` array (multi-frame) or be frame-like itself (legacy single-frame).
 */
interface SnapshotContent extends SnapshotFrameData {
  frames?: SnapshotFrameData[];
}

const MOUNT_TIME = Date.now();

/**
 * useStorageConfig: Gets plugin configuration toggle state and display mode via usePluginSelfConfig
 */
export const useStorageConfig = () => {
  const [selfConfig] = usePluginSelfConfig<P.StoragePluginConfig>();
  const { toggleCmd, toggleDashboardCmd } = usePluginCommands();

  return {
    isEnabled: selfConfig?.enabled === true,
    dashboardMode: selfConfig?.dashboardMode === true,
    toggleCmd,
    toggleDashboardCmd,
  };
};

/**
 * useStorageMetrics: Core logic - scans global state and builds asset reference map (with topological signature optimization)
 */
export const useStorageMetrics = () => {
  const { state } = useEditorState();
  const { assets } = useEditorServices();
  const { isEnabled } = useStorageConfig();

  // 1. Manual refresh mechanism
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

  // 2. Topology Signature
  const signature = useMemo(() => {
    if (!isEnabled) return '';

    const frameSigs = state.frames.order.map(fid => {
      const f = state.frames.byId[fid];
      const layerSigs = f.layers.order.map(lid => {
        const l = f.layers.byId[lid];
        return `${lid}:${l.name}:${l.assetId || ''}:${l.visible}:${l.locked}:${l.opacity}:${l.bounding.w}x${l.bounding.h}`;
      }).join(',');
      return `${fid}:${f.name}:${f.canvas.w}x${f.canvas.h}:${f.thumbnail?.assetId || ''}[${layerSigs}]`;
    }).join('|');

    const pastSig = state.history.past.map(s => s.id).join(',');
    const futureSig = state.history.future.map(s => s.id).join(',');

    const poolSigs = Object.values(assets.getPool())
      .map(e => `${e.id}:${e.state}`)
      .join(',');

    return `${frameSigs}##${pastSig}##${futureSig}##${poolSigs}##${refreshKey}`;
  }, [state.frames.order, state.frames.byId, state.history.past, state.history.future, assets, isEnabled, refreshKey]);

  // 3. Full asset and state topology audit logic
  const summary = useMemo<P.StorageSummary | null>(() => {
    if (!isEnabled || !signature) return null;

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

    // 3.1 Scan currently active frames
    state.frames.order.map(id => state.frames.byId[id]).forEach((f: Frame) => {
      if (f.thumbnail?.assetId) {
        addUsage(f.thumbnail.assetId, {
          assetId: f.thumbnail.assetId,
          source: 'thumbnail',
          frameId: f.id,
          frameName: f.name
        }, 'active');
      }
      f.layers.order.map(id => f.layers.byId[id]).forEach((l: Layer) => {
        if (l.assetId) {
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

    // 3.2 Scan history records
    const scanSnapshot = (snapshot: SnapshotContent, tag: P.AssetMetric['tags'][number]) => {
      const frames = snapshot.frames || [snapshot];
      frames.forEach((f) => {
        const thumbAssetId = f.thumbnail?.assetId || f.thumbnailAssetId;
        if (thumbAssetId) {
          addUsage(thumbAssetId, {
            assetId: thumbAssetId,
            source: 'thumbnail',
            frameId: f.id || 'snapshot',
            frameName: f.name || 'History Item'
          }, tag);
        }
        f.layers?.forEach((l) => {
          if (l.assetId) {
            addUsage(l.assetId, {
              assetId: l.assetId,
              source: 'history',
              frameId: f.id || 'snapshot',
              frameName: f.name || 'History Item',
              layerName: l.name
            }, tag);
          }
        });
      });
    };

    state.history.past.forEach(s => scanSnapshot(s as SnapshotContent, 'history'));
    state.history.future.forEach(s => scanSnapshot(s as SnapshotContent, 'history'));

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

    const activeAssetIds = new Set<string>();

    // Build artboard metrics data
    const frames: P.FrameMetric[] = state.frames.order.map(id => state.frames.byId[id]).map(f => {
      const thumbId = f.thumbnail?.assetId;
      const thumb = thumbId && pool[thumbId] ? buildAssetMetric(thumbId, pool[thumbId]) : undefined;
      if (thumbId) activeAssetIds.add(thumbId);

      const allLayerMetrics: Record<string, P.LayerMetric> = {};
      const subLayersMap: Record<string, P.LayerMetric[]> = {};

      f.layers.order.map(id => f.layers.byId[id]).forEach(l => {
        const asset = l.assetId && pool[l.assetId] ? buildAssetMetric(l.assetId, pool[l.assetId]) : undefined;
        if (l.assetId) activeAssetIds.add(l.assetId);

        const metric: P.LayerMetric = {
          id: l.id,
          name: l.name,
          type: l.type,
          visible: l.visible !== false,
          locked: l.locked === true,
          opacity: l.opacity ?? 100,
          bounding: l.bounding,
          asset,
          originalName: l.metadata?.originalName,
          format: l.metadata?.format,
          exif: l.metadata?.exif,
          parentId: l.parentId,
          role: l.role
        };

        allLayerMetrics[l.id] = metric;

        if (l.parentId) {
          if (!subLayersMap[l.parentId]) subLayersMap[l.parentId] = [];
          subLayersMap[l.parentId].push(metric);
        }
      });

      const layers: P.LayerMetric[] = [];
      f.layers.order.forEach(id => {
        const metric = allLayerMetrics[id];
        if (metric && !metric.parentId) {
          metric.subLayers = subLayersMap[metric.id] || [];
          layers.push(metric);
        }
      });

      return {
        id: f.id,
        name: f.name,
        canvas: f.canvas,
        camera: f.camera,
        rotation: f.rotation || 0,
        thumbnail: thumb,
        layers,
        historyCount: f.history?.past?.length || 0
      };
    });

    // Build history rollback record metrics
    const history: P.HistoryMoment[] = [...state.history.past].reverse().slice(0, 10).map((snapshot, i) => {
      const snap = snapshot as unknown as SnapshotContent;
      const snapFrames = snap.frames || [snap];
      const momentAssets: P.AssetMetric[] = [];
      const seenIds = new Set<string>();

      snapFrames.forEach((f) => {
        const thumbAssetId = f.thumbnail?.assetId || f.thumbnailAssetId;
        if (thumbAssetId && pool[thumbAssetId] && !seenIds.has(thumbAssetId)) {
          momentAssets.push(buildAssetMetric(thumbAssetId, pool[thumbAssetId]));
          seenIds.add(thumbAssetId);
        }
        f.layers?.forEach((l) => {
          if (l.assetId && pool[l.assetId] && !seenIds.has(l.assetId)) {
            momentAssets.push(buildAssetMetric(l.assetId, pool[l.assetId]));
            seenIds.add(l.assetId);
          }
        });
      });

      momentAssets.forEach(a => activeAssetIds.add(a.id));

      const firstAsset = momentAssets.find(a => a.type.startsWith('image')) || momentAssets[0];
      const exclusiveAssets = momentAssets.filter(a =>
        !state.frames.order.map(id => state.frames.byId[id]).some(f =>
          f.thumbnail?.assetId === a.id ||
          f.layers.order.map(lid => f.layers.byId[lid]).some(l => l.assetId === a.id)
        )
      );

      return {
        id: `moment-${i}`,
        timestamp: MOUNT_TIME - (i * 1000),
        label: snap.name || `Snapshot #${state.history.past.length - i}`,
        thumbnailUrl: firstAsset?.url || '',
        assets: momentAssets,
        totalSize: momentAssets.reduce((s, a) => s + a.size, 0),
        exclusiveSize: exclusiveAssets.reduce((s, a) => s + a.size, 0)
      };
    });

    // Scan the Future stack to avoid false orphans during undo/redo
    state.history.future.forEach((snapshot) => {
      const snap = snapshot as unknown as SnapshotContent;
      const snapFrames = snap.frames || [snap];
      snapFrames.forEach((f) => {
        const thumbAssetId = f.thumbnail?.assetId || f.thumbnailAssetId;
        if (thumbAssetId) activeAssetIds.add(thumbAssetId);
        f.layers?.forEach((l) => {
          if (l.assetId) activeAssetIds.add(l.assetId);
        });
      });
    });

    const detached: P.AssetMetric[] = Object.entries(pool)
      .filter(([id]) => !activeAssetIds.has(id))
      .map(([id, entry]) => buildAssetMetric(id, entry))
      .sort((a, b) => b.size - a.size);

    // 3.3 Sharded State DB physical size simulation calculations
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

    // C. history_index
    const historyObj = {
      past: state.history.past,
      future: state.history.future
    };
    const historyStr = JSON.stringify(historyObj);
    shards.push({ key: 'history_index', type: 'history_index', sizeBytes: historyStr.length });
    stateBytes += historyStr.length;

    return {
      totalBytes: Object.values(pool).reduce((sum, entry) => sum + entry.blob.size, 0),
      assetCount: Object.keys(pool).length,
      stateBytes,
      shards,
      frames,
      history,
      detached
    };
  }, [
    isEnabled,
    signature,
    assets,
    state.activeFrameId,
    state.frames.byId,
    state.frames.order,
    state.history.future,
    state.history.past
  ]);

  return { summary, refresh, isRefreshing };
};

/**
 * Copy reference details to clipboard
 */
export const copyAssetUsages = (asset: P.AssetMetric) => {
  const usageLines = asset.usages.map(u =>
    `- [${u.source.toUpperCase()}] ${u.frameName}${u.layerName ? ` > ${u.layerName}` : ''}`
  );
  const text = `Asset ID: ${asset.id}\nSize: ${asset.size} bytes\nType: ${asset.type}\nReferences (${asset.refCount}):\n${usageLines.join('\n')}`;

  navigator.clipboard.writeText(text).then(() => {
    console.log('Copied asset usages to clipboard');
  });
};

// ─── Model Cache Metrics ─────────────────────────────────────────────────────

/**
 * Information about downloaded AI model files in Cache Storage.
 */
export interface ModelCacheFileEntry {
  /** Short display name extracted from the URL */
  name: string;
  /** Full request URL */
  url: string;
  /** File size in bytes */
  size: number;
  /** Which cache bucket this file belongs to */
  cacheName: string;
}

export interface ModelCacheInfo {
  /** Total size of all cached model files in bytes */
  totalBytes: number;
  /** Number of cached files (ONNX weights, configs, tokenizers, etc.) */
  fileCount: number;
  /** Names of matched Cache Storage buckets */
  cacheNames: string[];
  /** Individual file entries with name, url, size, cacheName */
  files: ModelCacheFileEntry[];
}

const EMPTY_MODEL_CACHE: ModelCacheInfo = { totalBytes: 0, fileCount: 0, cacheNames: [], files: [] };

/**
 * Measure the total size of AI model files stored in Cache Storage.
 * transformers.js uses the Cache API to persist downloaded ONNX models.
 * Caches are identified by names containing 'transformers', 'huggingface', or 'onnx'.
 */
async function measureModelCache(): Promise<ModelCacheInfo> {
  try {
    if (typeof caches === 'undefined') return EMPTY_MODEL_CACHE;
    const names = await caches.keys();
    const matched: string[] = [];
    const files: ModelCacheFileEntry[] = [];
    let total = 0;
    let count = 0;
    for (const name of names) {
      if (name.includes('transformers') || name.includes('huggingface') || name.includes('onnx')) {
        matched.push(name);
        const cache = await caches.open(name);
        const keys = await cache.keys();
        for (const req of keys) {
          const resp = await cache.match(req);
          if (resp) {
            let fileSize = 0;
            // Use Content-Length header first (avoids reading entire body)
            const cl = resp.headers.get('content-length');
            if (cl) {
              fileSize = parseInt(cl, 10);
            } else {
              const blob = await resp.blob();
              fileSize = blob.size;
            }
            total += fileSize;
            count++;

            // Extract a short display name from the URL
            const url = req.url;
            const segments = url.split('/');
            const displayName = segments.slice(-2).join('/'); // e.g. "onnx/model_quantized.onnx"

            files.push({ name: displayName, url, size: fileSize, cacheName: name });
          }
        }
      }
    }
    // Sort files by size descending for better visibility
    files.sort((a, b) => b.size - a.size);
    return { totalBytes: total, fileCount: count, cacheNames: matched, files };
  } catch {
    return EMPTY_MODEL_CACHE;
  }
}

/**
 * Delete all AI model caches from Cache Storage and dispose the BgRemoval worker.
 */
export async function purgeModelCacheStorage(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const names = await caches.keys();
    for (const name of names) {
      if (name.includes('transformers') || name.includes('huggingface') || name.includes('onnx')) {
        await caches.delete(name);
      }
    }
    // Dispose the BgRemoval worker to release in-memory model instances
    const { bgRemovalClient } = await import('../../drawers/BgRemovalDrawer/worker/client');
    bgRemovalClient.dispose();
  } catch (err) {
    console.warn('[StorageInfo] Failed to purge model cache:', err);
  }
}

/**
 * useModelCacheMetrics: Asynchronously measures downloaded AI model cache size.
 * Returns the current cache info and a refresh function.
 */
export const useModelCacheMetrics = () => {
  const [info, setInfo] = useState<ModelCacheInfo>(EMPTY_MODEL_CACHE);

  const refresh = useCallback(async () => {
    const result = await measureModelCache();
    setInfo(result);
  }, []);

  // Measure on mount
  useEffect(() => {
    measureModelCache().then(setInfo);
  }, []);

  return { modelCache: info, refreshModelCache: refresh };
};
