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

import { createWorkerClient } from '../_shared/control/createWorkerClient';
import type { WorkerClient } from '../_shared/control/createWorkerClient';
import type { SegRequest, SegResult, SegProgress } from './worker.types';

/**
 * Segmentation Worker Client — singleton via createWorkerClient factory.
 *
 * Mode B Persistent Singleton:
 *   - Lazy: Worker constructed on first `run()`.
 *   - Encoder/Decoder ONNX sessions persist across calls.
 *   - Embedding cached: image embedding stays in Worker memory for instant decode.
 *   - Auto-disposes on WebGPU/ORT errors (corrupted backend state).
 *   - Per-action default timeouts:
 *       download: 0 (no timeout — user-controlled via network)
 *       encode: 60s (first-time may include download + encoding)
 *       decode: 10s (should be ~10ms normally)
 *       segment-all: 120s (full grid scan)
 *
 * On dispose, `resetEmbeddingCache()` is called to invalidate the stale
 * embedding reference (the new Worker won't have the previous embedding).
 */
const _rawClient = createWorkerClient<SegRequest, SegResult, SegProgress>(
  () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  {
    toolName: 'Segmentation',
    defaultTimeoutMs: (req) => {
      const timeouts: Record<string, number> = {
        'download': 0,
        'encode': 60_000,
        'decode': 10_000,
        'segment-all': 120_000,
      };
      return timeouts[req.action] ?? 30_000;
    },
    autoDisposeOnWebGpuError: true,
  },
);

/**
 * Wrapped segClient that resets the embedding cache on dispose.
 * This ensures `currentEmbeddingAssetId` is cleared when the Worker
 * is terminated (preventing stale embedding references).
 */
export const segClient: WorkerClient<SegRequest, SegResult, SegProgress> = {
  run: _rawClient.run,
  dispose: () => {
    _rawClient.dispose();
    // Lazy import to avoid circular dependency at module init time
    import('./commands').then(m => m.resetEmbeddingCache());
  },
};
