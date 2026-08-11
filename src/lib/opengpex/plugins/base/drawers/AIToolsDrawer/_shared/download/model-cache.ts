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
 * Model Cache Utilities
 *
 * Unified cache management for all AI model files. Models are stored
 * in browser Cache Storage under a single namespace (`CACHE_NAME`).
 *
 * This module provides:
 *   - isModelCached: Check if a model's files are present
 *   - deleteModelCache: Remove a model's cached files
 *   - getModelCacheSize: Get approximate cached size for a model
 *   - getCacheUrl: Get the canonical cache URL for a model file
 *
 * Both the download service and the worker runtime use the same
 * URL scheme, ensuring cache hits are consistent.
 */

/** Single cache namespace for all AI model files */
export const CACHE_NAME = 'opengpex-ai-models';

/** HuggingFace CDN base URL */
export const HF_BASE = 'https://huggingface.co';

/**
 * Get the canonical URL for a model file in cache.
 * This ensures download service and worker runtime use the same key.
 */
export function getCacheUrl(modelId: string, filename: string): string {
  return `${HF_BASE}/${modelId}/resolve/main/${filename}`;
}

/**
 * Check if a model has ANY cached files in the unified cache bucket.
 */
export async function isModelCached(modelId: string): Promise<boolean> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    return keys.some(req => {
      const url = req.url;
      return (
        url.includes(modelId) ||
        url.includes(modelId.replace('/', '%2F'))
      );
    });
  } catch {
    return false;
  }
}

/**
 * Check if specific model files are ALL cached.
 * More precise than isModelCached — useful for "ready to use" checks.
 */
export async function areFilesCached(
  modelId: string,
  filenames: string[],
): Promise<boolean> {
  try {
    const cache = await caches.open(CACHE_NAME);
    for (const filename of filenames) {
      const url = getCacheUrl(modelId, filename);
      const match = await cache.match(url);
      if (!match) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete cached files for a model from the unified cache bucket.
 *
 * If `filenames` is provided, only those specific files are deleted (precise mode).
 * If `filenames` is omitted, ALL cached files matching the modelId are deleted (legacy mode).
 *
 * Returns true if any files were deleted.
 */
export async function deleteModelCache(modelId: string, filenames?: string[]): Promise<boolean> {
  try {
    let deleted = false;
    const cache = await caches.open(CACHE_NAME);

    if (filenames && filenames.length > 0) {
      // Precise mode: delete only the specific files for this model variant
      for (const filename of filenames) {
        const url = getCacheUrl(modelId, filename);
        const success = await cache.delete(url);
        if (success) deleted = true;
      }
    } else {
      // Legacy mode: delete ALL files matching modelId (broad match)
      const keys = await cache.keys();
      for (const req of keys) {
        if (
          req.url.includes(modelId) ||
          req.url.includes(modelId.replace('/', '%2F'))
        ) {
          await cache.delete(req);
          deleted = true;
        }
      }
    }
    return deleted;
  } catch {
    return false;
  }
}

/**
 * Best-effort cleanup of partially-downloaded model files from HuggingFace caches.
 *
 * When a download is aborted mid-way, the @huggingface/transformers or ORT runtime
 * may have stored partial files in their internal cache buckets (separate from our
 * unified CACHE_NAME). This function scans all browser caches for entries matching
 * the given modelId and removes them.
 *
 * This is safe to call even if no partial files exist (no-op in that case).
 *
 * @param modelId - HuggingFace model ID (e.g. "briaai/RMBG-1.4")
 */
export async function cleanupPartialModelCache(modelId: string): Promise<void> {
  try {
    const cacheNames = await caches.keys();
    const hfCaches = cacheNames.filter(
      n => n.includes('transformers') || n.includes('onnx') || n.includes('huggingface')
    );
    for (const cacheName of hfCaches) {
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();
      for (const req of keys) {
        const url = req.url;
        const matchesModel = url.includes(modelId) || url.includes(modelId.replace('/', '%2F'));
        if (matchesModel) {
          await cache.delete(req);
        }
      }
    }
  } catch {
    // Best-effort — swallow errors
  }
}

/**
 * Get approximate cached size (in bytes) for a model.
 * Returns 0 if not cached or on error.
 */
export async function getModelCacheSize(modelId: string): Promise<number> {
  try {
    let totalSize = 0;
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    for (const req of keys) {
      if (
        req.url.includes(modelId) ||
        req.url.includes(modelId.replace('/', '%2F'))
      ) {
        const response = await cache.match(req);
        if (response) {
          const blob = await response.blob();
          totalSize += blob.size;
        }
      }
    }
    return totalSize;
  } catch {
    return 0;
  }
}
