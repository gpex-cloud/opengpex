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
 * createWorkerClient — Generic factory for AI tool Worker client singletons.
 *
 * Encapsulates the shared ~100-line orchestration pattern used by all AI tools:
 *   - Lazy Worker creation (Mode B persistent singleton)
 *   - Monotonic reqId for stale-response defense
 *   - Promise wrapping with cleanup (event listeners, timers)
 *   - Progress callback routing
 *   - AbortSignal support
 *   - Timeout with configurable default (per-request or static)
 *   - ArrayBuffer transfer (zero-copy for imageData)
 *   - Worker crash handling
 *   - Optional: auto-dispose on WebGPU/ORT runtime errors
 *
 * Each tool only needs to provide:
 *   - workerUrl: `new URL('./worker.ts', import.meta.url)` (bundler-resolved)
 *   - config: toolName, defaultTimeoutMs, autoDisposeOnWebGpuError
 *
 */

// ─── Type Constraints ────────────────────────────────────────────────────────

/** Minimum shape for a worker request (all tool requests extend this). */
interface BaseWorkerRequest {
  reqId: number;
  imageData?: { data: ArrayBuffer; width: number; height: number };
}

/** Minimum shape for a worker progress message. */
interface BaseWorkerProgress {
  type: 'progress';
  reqId: number;
}

/** Minimum shape for a worker result message. */
interface BaseWorkerResult {
  type: 'result';
  reqId: number;
}

/** Minimum shape for a worker error message. */
interface BaseWorkerError {
  type: 'error';
  reqId: number;
  error: string;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface WorkerClientConfig<TRequest> {
  /**
   * Tool name used in error messages.
   * E.g. "BgRemover", "Upscale", "Segmentation", "Inpaint eraser"
   */
  toolName: string;

  /**
   * Default timeout in ms. Can be:
   * - A static number (0 = no timeout)
   * - A function of the request (e.g. Segmentation uses per-action timeouts)
   */
  defaultTimeoutMs: number | ((req: Omit<TRequest, 'reqId'>) => number);

  /**
   * Whether to auto-dispose the Worker on WebGPU/ORT runtime errors.
   * These errors corrupt ORT's internal WebGPU backend state, making ALL
   * subsequent WebGPU inference fail. Disposing forces a clean restart.
   * @default false
   */
  autoDisposeOnWebGpuError?: boolean;

  /**
   * Extract Transferable objects from the request for zero-copy postMessage.
   * Default: transfers `req.imageData.data` if present.
   */
  getTransferables?: (req: Omit<TRequest, 'reqId'>) => Transferable[];
}

// ─── Return Type ─────────────────────────────────────────────────────────────

export interface WorkerClient<TRequest, TResult, TProgress> {
  /**
   * Submit a request to the Worker.
   *
   * @param req - Request payload (without reqId — auto-assigned)
   * @param opts.signal - AbortSignal for cancellation
   * @param opts.timeoutMs - Hard timeout (overrides default)
   * @param opts.onProgress - Called with progress updates
   * @returns Promise resolving with the final result
   */
  run(
    req: Omit<TRequest, 'reqId'>,
    opts?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onProgress?: (progress: TProgress) => void;
    },
  ): Promise<TResult>;

  /** Terminate the Worker and release GPU/WASM memory. Idempotent. */
  dispose(): void;
}

// ─── WebGPU Error Detection ──────────────────────────────────────────────────

const WEBGPU_ERROR_PATTERNS = [
  'ortrun',
  'webgpu',
  'storage_buffer',
  'shaderhelper',
  'device lost',
  'gpudevice',
];

function isWebGpuOrtError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase();
  return WEBGPU_ERROR_PATTERNS.some(p => lower.includes(p));
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a typed Worker client singleton.
 *
 * IMPORTANT: The `createWorker` parameter MUST be a function that contains
 * `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`
 * as a single expression. Bundlers (webpack/Turbopack) statically analyze
 * this pattern to detect Worker entry points. Passing a pre-resolved URL
 * separately breaks bundler detection.
 *
 * Usage:
 * ```ts
 * export const bgRemoverClient = createWorkerClient<BgRemoverRequest, BgRemoverResult, BgRemoverProgress>(
 *   () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
 *   { toolName: 'BgRemover', defaultTimeoutMs: 30_000, autoDisposeOnWebGpuError: true },
 * );
 * ```
 */
export function createWorkerClient<
  TRequest extends BaseWorkerRequest,
  TResult extends BaseWorkerResult,
  TProgress extends BaseWorkerProgress = BaseWorkerProgress,
>(
  createWorker: () => Worker,
  config: WorkerClientConfig<TRequest>,
): WorkerClient<TRequest, TResult, TProgress> {
  let worker: Worker | null = null;
  let currentReqId = 0;

  const {
    toolName,
    defaultTimeoutMs,
    autoDisposeOnWebGpuError = false,
    getTransferables,
  } = config;

  /** Lazy-create or reuse the singleton Worker. */
  function ensure(): Worker {
    if (worker) return worker;
    if (typeof Worker === 'undefined') {
      throw new Error('Web Worker is not available in this environment');
    }
    worker = createWorker();
    return worker;
  }

  /** Terminate the Worker. */
  function dispose(): void {
    if (worker) {
      worker.terminate();
      worker = null;
    }
  }

  /** Resolve the effective timeout for a request. */
  function resolveTimeout(req: Omit<TRequest, 'reqId'>, optsTimeoutMs?: number): number {
    if (optsTimeoutMs !== undefined) return optsTimeoutMs;
    if (typeof defaultTimeoutMs === 'function') {
      return defaultTimeoutMs(req);
    }
    return defaultTimeoutMs;
  }

  /** Extract transferables from a request. */
  function extractTransferables(req: Omit<TRequest, 'reqId'>): Transferable[] {
    if (getTransferables) return getTransferables(req);
    // Default: transfer imageData.data ArrayBuffer if present
    const imgData = (req as unknown as BaseWorkerRequest).imageData;
    if (imgData?.data) return [imgData.data];
    return [];
  }

  type ResponseMsg = TProgress | TResult | BaseWorkerError;

  function run(
    req: Omit<TRequest, 'reqId'>,
    opts?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onProgress?: (progress: TProgress) => void;
    },
  ): Promise<TResult> {
    const timeoutMs = resolveTimeout(req, opts?.timeoutMs);
    const reqId = ++currentReqId;

    let w: Worker;
    try {
      w = ensure();
    } catch (err) {
      return Promise.reject(err);
    }

    return new Promise<TResult>((resolve, reject) => {
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
        opts?.signal?.removeEventListener('abort', onAbort);
      };

      const onMessage = (ev: MessageEvent<ResponseMsg>) => {
        const msg = ev.data;
        if (msg?.reqId !== reqId) return;

        switch (msg.type) {
          case 'progress':
            opts?.onProgress?.(msg as TProgress);
            break;
          case 'result':
            cleanup();
            resolve(msg as TResult);
            break;
          case 'error':
            cleanup();
            if (autoDisposeOnWebGpuError && isWebGpuOrtError((msg as BaseWorkerError).error ?? '')) {
              console.warn(`[${toolName}Client] WebGPU ORT error — disposing worker for clean restart`);
              dispose();
            }
            reject(new Error(`${toolName} worker error: ${(msg as BaseWorkerError).error}`));
            break;
        }
      };

      const onError = (ev: ErrorEvent) => {
        cleanup();
        dispose();
        reject(new Error(`${toolName} worker crashed: ${ev.message ?? 'unknown error'}`));
      };

      const onAbort = () => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };

      // timeoutMs <= 0 means "no timeout" (model download/large inference can take minutes)
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            cleanup();
            dispose();
            reject(new Error(`${toolName} timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;

      w.addEventListener('message', onMessage);
      w.addEventListener('error', onError);
      opts?.signal?.addEventListener('abort', onAbort);

      const message = { ...req, reqId } as TRequest;
      const transferables = extractTransferables(req);

      if (transferables.length > 0) {
        w.postMessage(message, transferables);
      } else {
        w.postMessage(message);
      }
    });
  }

  return { run, dispose };
}
