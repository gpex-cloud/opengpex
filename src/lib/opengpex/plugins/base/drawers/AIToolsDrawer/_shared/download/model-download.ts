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
 * Model Download Service
 *
 * Framework-agnostic download service for AI model files. Uses raw fetch
 * with ReadableStream for progress tracking and Cache Storage for persistence.
 *
 * This service is completely decoupled from any inference runtime (ort,
 * transformers.js, WebLLM, etc). Its only job is: "pull files from URLs
 * into Cache Storage with progress reporting".
 *
 * Design principles:
 *   - Pure fetch + Cache API (zero inference dependencies)
 *   - AbortSignal support for reliable cancellation
 *   - Per-file and overall progress aggregation
 *   - Sliding-window speed estimation (last 3 seconds)
 *   - Handles Content-Length absence gracefully (indeterminate mode)
 *   - Atomic: partial downloads are NOT persisted on cancel/error
 */

import { CACHE_NAME, getCacheUrl } from './model-cache';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ModelFile {
  /** Filename relative to model root (e.g. "encoder.onnx") */
  filename: string;
  /** Full URL to download from. If omitted, derived from modelId + filename */
  url?: string;
  /** Expected file size in bytes (optional, for pre-download total estimation) */
  expectedBytes?: number;
}

export interface DownloadProgress {
  stage: 'idle' | 'downloading' | 'done' | 'error' | 'cancelled';
  /** Currently downloading file name */
  currentFile: string | null;
  /** Index of current file (0-based) */
  currentFileIdx: number;
  /** Total number of files to download */
  totalFiles: number;
  /** Bytes loaded for current file */
  fileLoaded: number;
  /** Total bytes for current file (0 if Content-Length unavailable) */
  fileTotal: number;
  /** Cumulative bytes loaded across all files */
  overallLoaded: number;
  /** Cumulative total bytes across all files (0 if any Content-Length unavailable) */
  overallTotal: number;
  /** Download speed in bytes/second (3-second sliding window) */
  speedBps: number;
  /** Estimated time remaining in seconds */
  etaSeconds: number;
  /** Error message (only when stage = 'error') */
  error: string | null;
}

export const INITIAL_DOWNLOAD_PROGRESS: DownloadProgress = {
  stage: 'idle',
  currentFile: null,
  currentFileIdx: 0,
  totalFiles: 0,
  fileLoaded: 0,
  fileTotal: 0,
  overallLoaded: 0,
  overallTotal: 0,
  speedBps: 0,
  etaSeconds: 0,
  error: null,
};

export interface DownloadOptions {
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Progress callback — called frequently during download */
  onProgress?: (progress: DownloadProgress) => void;
}

// ─── Speed Estimator ─────────────────────────────────────────────────────────

export class SpeedEstimator {
  private samples: { time: number; bytes: number }[] = [];
  private _totalBytes = 0;
  private _currentBytes = 0;

  update(loaded: number, total: number) {
    this._currentBytes = loaded;
    this._totalBytes = total;
    this.samples.push({ time: Date.now(), bytes: loaded });
    // Keep only last 3 seconds
    const cutoff = Date.now() - 3000;
    this.samples = this.samples.filter(s => s.time >= cutoff);
  }

  get bytesPerSecond(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.time - first.time) / 1000;
    return dt > 0 ? (last.bytes - first.bytes) / dt : 0;
  }

  get etaSeconds(): number {
    const speed = this.bytesPerSecond;
    if (speed <= 0 || this._totalBytes <= 0) return Infinity;
    return (this._totalBytes - this._currentBytes) / speed;
  }

  reset() {
    this.samples = [];
    this._totalBytes = 0;
    this._currentBytes = 0;
  }
}

/** Constant progress-report cadence (time-driven, independent of chunk size). */
const REPORT_INTERVAL_MS = 120;

/**
 * Zero-allocation sliding-window speed estimator (fixed ring buffer).
 * Only samples within WINDOW_MS contribute to the speed calculation.
 */
export class RingSpeedEstimator {
  private static readonly WINDOW_MS = 2500;
  private static readonly MAX_SLOTS = 32;

  private times = new Float64Array(RingSpeedEstimator.MAX_SLOTS);
  private bytes = new Float64Array(RingSpeedEstimator.MAX_SLOTS);
  private head = 0;
  private count = 0;

  update(currentBytes: number, now: number): void {
    const N = RingSpeedEstimator.MAX_SLOTS;
    this.times[this.head] = now;
    this.bytes[this.head] = currentBytes;
    this.head = (this.head + 1) % N;
    if (this.count < N) this.count++;
  }

  /** Bytes/sec over the most recent window. */
  getSpeed(): number {
    if (this.count < 2) return 0;
    const N = RingSpeedEstimator.MAX_SLOTS;
    const newest = (this.head - 1 + N) % N;
    const tNew = this.times[newest];
    let oldest = newest;
    for (let i = 1; i < this.count; i++) {
      const idx = (newest - i + N) % N;
      if (tNew - this.times[idx] > RingSpeedEstimator.WINDOW_MS) break;
      oldest = idx;
    }
    if (oldest === newest) oldest = (newest - 1 + N) % N;
    const dt = (tNew - this.times[oldest]) / 1000;
    const db = this.bytes[newest] - this.bytes[oldest];
    return dt > 0.05 ? Math.max(0, db / dt) : 0;
  }

  getEta(currentBytes: number, totalBytes: number, speedBps: number): number {
    if (speedBps <= 0 || totalBytes <= 0 || currentBytes >= totalBytes) return 0;
    return (totalBytes - currentBytes) / speedBps;
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
  }
}

// ─── Download Service ────────────────────────────────────────────────────────

/**
 * Download model files to Cache Storage with progress reporting.
 *
 * Files that are already cached are skipped (instant). Files are written
 * to cache only AFTER the full download completes (no partial writes).
 *
 * @param modelId - HuggingFace model ID (e.g. "SharpAI/sam2-hiera-tiny-onnx")
 * @param files - List of files to download
 * @param opts - Signal and progress callback
 * @throws DOMException (AbortError) if cancelled
 * @throws Error on network failure
 */
export async function downloadModel(
  modelId: string,
  files: ModelFile[],
  opts?: DownloadOptions,
): Promise<void> {
  const { signal, onProgress } = opts ?? {};

  // Pre-check: resolve URLs and probe cache
  const cache = await caches.open(CACHE_NAME);
  const filesToDownload: { filename: string; url: string; expectedBytes: number }[] = [];
  let overallTotal = 0;
  let overallLoaded = 0;

  for (const file of files) {
    const url = file.url ?? getCacheUrl(modelId, file.filename);
    const cached = await cache.match(url);
    if (cached) {
      // Already cached — count toward overall total but skip download
      const headerLen = Number(cached.headers.get('content-length') || 0);
      const size = file.expectedBytes ?? (headerLen > 0 ? headerLen : (await cached.blob()).size);
      overallTotal += size;
      overallLoaded += size;
    } else {
      filesToDownload.push({
        filename: file.filename,
        url,
        expectedBytes: file.expectedBytes ?? 0,
      });
      overallTotal += file.expectedBytes ?? 0;
    }
  }

  // If all files are already cached, we're done
  if (filesToDownload.length === 0) {
    onProgress?.({
      ...INITIAL_DOWNLOAD_PROGRESS,
      stage: 'done',
      totalFiles: files.length,
      currentFileIdx: files.length,
      overallLoaded,
      overallTotal,
    });
    return;
  }

  const speedEstimator = new RingSpeedEstimator();
  let downloadedSoFar = overallLoaded; // bytes from already-cached files

  for (let i = 0; i < filesToDownload.length; i++) {
    const file = filesToDownload[i];

    // Check abort before starting each file
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Report file start
    onProgress?.({
      stage: 'downloading',
      currentFile: file.filename,
      currentFileIdx: i,
      totalFiles: filesToDownload.length,
      fileLoaded: 0,
      fileTotal: file.expectedBytes,
      overallLoaded: downloadedSoFar,
      overallTotal,
      speedBps: speedEstimator.getSpeed(),
      etaSeconds: 0,
      error: null,
    });

    // Fetch with abort support
    const response = await fetch(file.url, { signal });
    if (!response.ok) {
      const errMsg = `Failed to download ${file.filename}: ${response.status} ${response.statusText}`;
      onProgress?.({
        stage: 'error',
        currentFile: file.filename,
        currentFileIdx: i,
        totalFiles: filesToDownload.length,
        fileLoaded: 0,
        fileTotal: 0,
        overallLoaded: downloadedSoFar,
        overallTotal,
        speedBps: 0,
        etaSeconds: 0,
        error: errMsg,
      });
      throw new Error(errMsg);
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    const fileTotal = contentLength || file.expectedBytes;

    // Update overall total with real content-length if we didn't have expectedBytes
    if (contentLength > 0 && file.expectedBytes === 0) {
      overallTotal += contentLength;
    } else if (contentLength > 0 && file.expectedBytes > 0) {
      // Correct estimate with real value
      overallTotal = overallTotal - file.expectedBytes + contentLength;
    }

    if (!response.body) {
      throw new Error(`No response body for ${file.filename}`);
    }

    let fileLoaded = 0;
    let lastReportTime = performance.now();

    const emit = (now: number, final: boolean) => {
      speedEstimator.update(downloadedSoFar, now);
      const speed = speedEstimator.getSpeed();
      onProgress?.({
        stage: 'downloading',
        currentFile: file.filename,
        currentFileIdx: i,
        totalFiles: filesToDownload.length,
        fileLoaded,
        fileTotal,
        overallLoaded: downloadedSoFar,
        overallTotal,
        speedBps: speed,
        etaSeconds: final ? 0 : speedEstimator.getEta(downloadedSoFar, overallTotal, speed),
        error: null,
      });
    };

    // Pass-through counting stream: no chunk is retained in the JS heap.
    const countingStream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        fileLoaded += chunk.byteLength;
        downloadedSoFar += chunk.byteLength;
        controller.enqueue(chunk);
        const now = performance.now();
        if (now - lastReportTime >= REPORT_INTERVAL_MS) {
          lastReportTime = now;
          emit(now, false);
        }
      },
      flush() {
        emit(performance.now(), true);
      },
    });

    const cacheHeaders: Record<string, string> = {
      'content-type': 'application/octet-stream',
    };
    // Only forward a real, server-provided length (never for chunked/unknown)
    if (contentLength > 0) {
      cacheHeaders['content-length'] = String(contentLength);
    }

    try {
      await cache.put(
        file.url,
        new Response(response.body.pipeThrough(countingStream), { headers: cacheHeaders }),
      );
      if (contentLength > 0 && fileLoaded !== contentLength) {
        throw new Error(
          `Download truncated for ${file.filename}: expected ${contentLength} bytes, received ${fileLoaded}`,
        );
      }
    } catch (err) {
      // Atomic rollback: never leave a partial model in the cache
      await cache.delete(file.url).catch(() => {});
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      throw new Error(`Download stream error for ${file.filename}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // All files downloaded successfully
  onProgress?.({
    stage: 'done',
    currentFile: null,
    currentFileIdx: filesToDownload.length,
    totalFiles: filesToDownload.length,
    fileLoaded: 0,
    fileTotal: 0,
    overallLoaded: downloadedSoFar,
    overallTotal,
    speedBps: speedEstimator.getSpeed(),
    etaSeconds: 0,
    error: null,
  });
}
