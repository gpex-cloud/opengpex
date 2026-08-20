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
 *   - exportModelAsZip: Export cached model files as a zip Blob
 *   - importModelFromZip: Import model files from a zip Blob into Cache Storage
 *
 * Both the download service and the worker runtime use the same
 * URL scheme, ensuring cache hits are consistent.
 */

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

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

// ─── Export / Import ─────────────────────────────────────────────────────────

/** Manifest format embedded in exported zip packages */
export interface ModelManifest {
  format: 'opengpex-model-v1';
  modelId: string;
  modelName: string;
  files: { filename: string; size: number }[];
  exportedAt: string;
}

/** Progress callback for import operations */
export interface ImportProgressCallback {
  (current: number, total: number, currentFile: string): void;
}

/**
 * Export cached model files as a zip Blob.
 * Returns null if model is not fully cached.
 *
 * The zip contains:
 *   - manifest.json (metadata + file list)
 *   - All model files listed in the `files` parameter
 *
 * @param modelId - HuggingFace model ID (e.g. "briaai/RMBG-1.4")
 * @param modelName - Human-readable model name (for manifest)
 * @param files - List of files to export (same as download config)
 */
export async function exportModelAsZip(
  modelId: string,
  modelName: string,
  files: { filename: string }[],
): Promise<Blob | null> {
  const cache = await caches.open(CACHE_NAME);

  // Collect file data from cache
  const zipData: Record<string, Uint8Array> = {};
  const manifestFiles: { filename: string; size: number }[] = [];

  for (const file of files) {
    const url = getCacheUrl(modelId, file.filename);
    const response = await cache.match(url);
    if (!response) {
      // Model not fully cached — cannot export
      return null;
    }
    const buffer = await response.arrayBuffer();
    zipData[file.filename] = new Uint8Array(buffer);
    manifestFiles.push({ filename: file.filename, size: buffer.byteLength });
  }

  // Create manifest
  const manifest: ModelManifest = {
    format: 'opengpex-model-v1',
    modelId,
    modelName,
    files: manifestFiles,
    exportedAt: new Date().toISOString(),
  };

  // Add manifest to zip data
  zipData['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));

  // Create zip synchronously (fflate zipSync)
  const zipped = zipSync(zipData, { level: 0 }); // level 0 = store only (model files are already compressed)

  return new Blob([zipped], { type: 'application/zip' });
}

/**
 * Import model files from a zip Blob into Cache Storage.
 * Validates manifest and file integrity before writing.
 *
 * @param expectedModelId - The modelId that should match the zip manifest
 * @param expectedFiles - The files expected for this model (from config)
 * @param zipBlob - The zip file selected by the user
 * @param onProgress - Optional progress callback (current, total, currentFile)
 * @returns Success/failure result with optional error message
 */
export async function importModelFromZip(
  expectedModelId: string,
  expectedFiles: { filename: string }[],
  zipBlob: Blob,
  onProgress?: ImportProgressCallback,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Read zip into memory
    const zipBuffer = await zipBlob.arrayBuffer();
    const unzipped = unzipSync(new Uint8Array(zipBuffer));

    // Parse manifest
    const manifestData = unzipped['manifest.json'];
    if (!manifestData) {
      return { success: false, error: 'Not a valid OpenGPEX model package (manifest.json missing)' };
    }

    let manifest: ModelManifest;
    try {
      manifest = JSON.parse(strFromU8(manifestData));
    } catch {
      return { success: false, error: 'Invalid manifest.json format' };
    }

    // Validate format
    if (manifest.format !== 'opengpex-model-v1') {
      return { success: false, error: `Unsupported package format: ${manifest.format}` };
    }

    // Validate modelId
    if (manifest.modelId !== expectedModelId) {
      return {
        success: false,
        error: `This package is for model "${manifest.modelId}", but current model is "${expectedModelId}"`,
      };
    }

    // Validate that all expected files are present in the zip
    const expectedFilenames = expectedFiles.map(f => f.filename);
    const missingFiles = expectedFilenames.filter(f => !unzipped[f]);
    if (missingFiles.length > 0) {
      return { success: false, error: `Package is missing files: ${missingFiles.join(', ')}` };
    }

    // Validate file sizes (must not be 0)
    for (const filename of expectedFilenames) {
      if (unzipped[filename].byteLength === 0) {
        return { success: false, error: `File "${filename}" is empty (0 bytes)` };
      }
    }

    // Write files to Cache Storage
    const cache = await caches.open(CACHE_NAME);
    const total = expectedFilenames.length;

    for (let i = 0; i < expectedFilenames.length; i++) {
      const filename = expectedFilenames[i];
      onProgress?.(i + 1, total, filename);

      const fileData = unzipped[filename];
      const url = getCacheUrl(expectedModelId, filename);
      await cache.put(
        url,
        new Response(fileData.buffer, {
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(fileData.byteLength),
          },
        }),
      );
    }

    return { success: true };
  } catch (err) {
    // Handle invalid zip format
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('invalid') || message.includes('Invalid')) {
      return { success: false, error: 'Invalid file format — not a valid zip file' };
    }
    return { success: false, error: `Import failed: ${message}` };
  }
}
