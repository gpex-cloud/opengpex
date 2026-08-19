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

import { useState, useCallback, useEffect } from 'react';

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

/** A group of cached files belonging to the same model (org/repo). */
export interface ModelCacheGroup {
  /** HuggingFace model ID (e.g. "onnx-community/sam2.1-hiera-tiny-ONNX") */
  modelId: string;
  /** Total bytes for this model's files */
  totalBytes: number;
  /** Files within this model */
  files: ModelCacheFileEntry[];
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
  /** Files grouped by model ID (org/repo), sorted by group size descending */
  groups: ModelCacheGroup[];
}

const EMPTY_MODEL_CACHE: ModelCacheInfo = { totalBytes: 0, fileCount: 0, cacheNames: [], files: [], groups: [] };

/**
 * Measure the total size of AI model files stored in Cache Storage.
 * All AI models are stored under the unified 'opengpex-ai-models' cache bucket.
 */
async function measureModelCache(): Promise<ModelCacheInfo> {
  try {
    if (typeof caches === 'undefined') return EMPTY_MODEL_CACHE;
    const CACHE_NAME = 'opengpex-ai-models';
    const names = await caches.keys();
    if (!names.includes(CACHE_NAME)) return EMPTY_MODEL_CACHE;

    const files: ModelCacheFileEntry[] = [];
    let total = 0;
    let count = 0;

    const cache = await caches.open(CACHE_NAME);
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

        // Extract model ID and file path from HuggingFace URL pattern:
        //   https://huggingface.co/{org}/{model}/resolve/main/{filepath}
        const url = req.url;
        const resolveIdx = url.indexOf('/resolve/main/');
        let displayName: string;
        if (resolveIdx !== -1) {
          // Extract filepath after /resolve/main/
          displayName = url.slice(resolveIdx + '/resolve/main/'.length);
        } else {
          // Fallback: last 2 segments
          const segments = url.split('/');
          displayName = segments.slice(-2).join('/');
        }

        files.push({ name: displayName, url, size: fileSize, cacheName: CACHE_NAME });
      }
    }
    // Sort files by size descending for better visibility
    files.sort((a, b) => b.size - a.size);

    // Group files by model ID (extracted from URL)
    const groupMap = new Map<string, ModelCacheFileEntry[]>();
    for (const file of files) {
      const resolveIdx = file.url.indexOf('/resolve/main/');
      let modelId = 'unknown';
      if (resolveIdx !== -1) {
        // URL before /resolve/main/ ends with {org}/{model}
        const prefix = file.url.slice(0, resolveIdx);
        const parts = prefix.split('/');
        modelId = parts.slice(-2).join('/'); // e.g. "onnx-community/sam2.1-hiera-tiny-ONNX"
      }
      if (!groupMap.has(modelId)) groupMap.set(modelId, []);
      groupMap.get(modelId)!.push(file);
    }

    const groups: ModelCacheGroup[] = [...groupMap.entries()].map(([modelId, gFiles]) => ({
      modelId,
      totalBytes: gFiles.reduce((sum, f) => sum + f.size, 0),
      files: gFiles,
    }));
    groups.sort((a, b) => b.totalBytes - a.totalBytes);

    return { totalBytes: total, fileCount: count, cacheNames: [CACHE_NAME], files, groups };
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
    await caches.delete('opengpex-ai-models');
    // Dispose the BgRemoval worker to release in-memory model instances
    const { bgRemoverClient } = await import('../../../drawers/AIToolsDrawer/bgremover/client');
    bgRemoverClient.dispose();
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
