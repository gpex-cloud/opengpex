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
 * WorkerBridge: Communication bridge between main thread and Web Worker
 * Implements a simple RPC (Remote Procedure Call) protocol
 */

interface WorkerResponse<T = unknown> {
  id: string;
  success: boolean;
  result?: T;
  error?: string;
}

export class WorkerBridge {
  private static instance: WorkerBridge;
  private worker: Worker | null = null;
  private pendingRequests: Map<string, { resolve: (val: unknown) => void; reject: (err: Error) => void }> = new Map();
  private nextId = 0;

  private constructor() {
    if (typeof window !== 'undefined') {
      // Dynamically load Worker (adapted for Next.js/Webpack/Vite environments)
      this.worker = new Worker(new URL('./processor.worker.ts', import.meta.url));
      this.worker.onmessage = this.handleMessage.bind(this);
      this.worker.onerror = (err) => console.error('[WorkerBridge] Worker Error:', err);
    }
  }

  public static getInstance(): WorkerBridge {
    if (!WorkerBridge.instance) {
      WorkerBridge.instance = new WorkerBridge();
    }
    return WorkerBridge.instance;
  }

  /**
   * Sends asynchronous request to Worker
   */
  public async request<T = unknown>(type: string, payload: unknown, transfer: Transferable[] = []): Promise<T> {
    if (!this.worker) throw new Error('Worker not supported or initialized');

    const id = `req_${this.nextId++}_${Date.now()}`;
    
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, { 
        resolve: resolve as (val: unknown) => void, 
        reject 
      });
      this.worker!.postMessage({ id, type, payload }, transfer);
    });
  }

  private handleMessage(e: MessageEvent<WorkerResponse>) {
    const { id, success, result, error } = e.data;
    const request = this.pendingRequests.get(id);

    if (request) {
      if (success) {
        request.resolve(result);
      } else {
        request.reject(new Error(error || 'Unknown worker error'));
      }
      this.pendingRequests.delete(id);
    }
  }

  public async resample(src: string, targetSize: { w: number; h: number }): Promise<Blob> {
    const result = await this.request<{ blob: Blob }>('RESAMPLE_IMAGE', { src, targetSize });
    return result.blob;
  }
}



export const workerBridge = WorkerBridge.getInstance();
