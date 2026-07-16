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
 * ComfyClient — HTTP (via /api/comfy proxy) + WebSocket (browser direct) client.
 *
 * HTTP requests go through Next.js API Route to bypass CORS.
 * WebSocket connects directly to ComfyUI (WS is not subject to same-origin policy).
 */

import type { ExecutionProgress, ConnectionMode } from '../protocols';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ComfySystemStats {
  system: {
    os: string;
    python_version: string;
    embedded_python: boolean;
  };
  devices: Array<{
    name: string;
    type: string;
    index: number;
    vram_total: number;
    vram_free: number;
    torch_vram_total: number;
    torch_vram_free: number;
  }>;
}

export interface ComfyHistoryOutput {
  images?: Array<{
    filename: string;
    subfolder: string;
    type: string;
  }>;
}

export interface ComfyHistoryEntry {
  prompt: [number, string, object, object, object];
  outputs: Record<string, ComfyHistoryOutput>;
  status: { status_str: string; completed: boolean };
}

type ProgressListener = (progress: ExecutionProgress) => void;
type CompleteListener = (promptId: string) => void;
type ErrorListener = (error: string) => void;

// ─── ComfyClient Class ─────────────────────────────────────────────────────────

export class ComfyClient {
  private ws: WebSocket | null = null;
  private clientId: string;
  private comfyUrl: string;
  private connectionMode: ConnectionMode;
  private listeners = {
    progress: new Set<ProgressListener>(),
    complete: new Set<CompleteListener>(),
    error: new Set<ErrorListener>(),
  };

  constructor(comfyUrl: string, connectionMode: ConnectionMode = 'auto') {
    this.comfyUrl = comfyUrl.replace(/\/+$/, '');
    this.connectionMode = connectionMode;
    this.clientId = crypto.randomUUID();
  }

  /**
   * Resolves whether to use direct browser fetch or server-side proxy.
   *
   * Decision matrix (auto mode):
   *
   * | App Location      | ComfyUI Target         | Result | Reason                                          |
   * |-------------------|------------------------|--------|------------------------------------------------|
   * | localhost (dev)    | any                    | PROXY  | Server can reach any target from same machine   |
   * | cloud (HTTPS)     | localhost:8188         | DIRECT | Browser HTTPS→HTTP localhost exception works     |
   * | cloud (HTTPS)     | https://xxx.ngrok.io   | DIRECT | HTTPS→HTTPS, no mixed content issue             |
   * | cloud (HTTPS)     | http://192.168.x.x    | DIRECT | Will fail (Mixed Content), but proxy also can't |
   * |                   |                        |        | reach private IP from cloud. User needs tunnel.  |
   *
   * Explicit overrides:
   * - 'direct': Always browser → ComfyUI directly (requires CORS on ComfyUI)
   * - 'proxy': Always browser → /api/comfy/ → ComfyUI (requires server network reach)
   */
  private get useDirect(): boolean {
    if (this.connectionMode === 'direct') return true;
    if (this.connectionMode === 'proxy') return false;

    // Auto mode
    if (typeof window === 'undefined') return false; // SSR context → proxy

    const appHostname = window.location.hostname;
    const isLocalApp = appHostname === 'localhost' || appHostname === '127.0.0.1' || appHostname === '0.0.0.0';

    if (isLocalApp) {
      // App is running locally (dev mode) → use proxy
      // The Next.js server and ComfyUI are likely on the same machine/network
      return false;
    }

    // App is on cloud/remote (non-localhost) → proxy server can NOT reach user's
    // local ComfyUI, so we MUST use direct browser fetch.
    // This works for:
    //   • http://localhost:8188 — browser HTTPS→HTTP localhost exception
    //   • https://xxx.ngrok.io — HTTPS→HTTPS, no mixed content
    // This will FAIL for:
    //   • http://192.168.x.x:8188 — Mixed Content (user needs SSH tunnel or HTTPS)
    //   But proxy would also fail (cloud server can't reach 192.168.x.x), so direct
    //   at least gives the user a clear CORS/Mixed-Content error message.
    return true;
  }

  // ─── WebSocket Connection ──────────────────────────────────────────────────

  connectWs(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const wsUrl = this.comfyUrl.replace(/^http/, 'ws') + `/ws?clientId=${this.clientId}`;

    // Validate URL before attempting connection to prevent crashes on invalid/partial URLs
    try {
      const parsed = new URL(wsUrl);
      // Port validation: new URL() does NOT reject ports > 65535
      if (parsed.port && (parseInt(parsed.port, 10) > 65535 || parseInt(parsed.port, 10) < 1)) {
        throw new Error('Port out of range');
      }
    } catch {
      this.listeners.error.forEach(fn => fn(`Invalid WebSocket URL: ${wsUrl}`));
      return;
    }

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (e) {
      this.listeners.error.forEach(fn => fn(`Failed to create WebSocket: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        this.handleWsMessage(msg);
      } catch {
        // Ignore non-JSON messages (e.g. binary preview frames)
      }
    };

    this.ws.onerror = () => {
      this.listeners.error.forEach(fn => fn('WebSocket connection error'));
    };

    this.ws.onclose = () => {
      this.ws = null;
    };
  }

  disconnectWs(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private handleWsMessage(msg: { type: string; data?: Record<string, unknown> }): void {
    switch (msg.type) {
      case 'progress': {
        const data = msg.data as { value: number; max: number; prompt_id?: string } | undefined;
        if (data) {
          this.listeners.progress.forEach(fn => fn({
            value: data.value,
            max: data.max,
            promptId: data.prompt_id || '',
          }));
        }
        break;
      }
      case 'executing': {
        // ComfyUI sends {type:'executing', data:{node: null, prompt_id:'...'}}
        // when the entire workflow has finished executing.
        const data = msg.data as { node?: string | null; prompt_id?: string } | undefined;
        if (data && data.node === null && data.prompt_id) {
          this.listeners.complete.forEach(fn => fn(data.prompt_id!));
        }
        break;
      }
      case 'execution_success': {
        // Some ComfyUI versions also send this on completion
        const data = msg.data as { prompt_id?: string } | undefined;
        if (data?.prompt_id) {
          this.listeners.complete.forEach(fn => fn(data.prompt_id!));
        }
        break;
      }
      case 'execution_error': {
        const data = msg.data as { exception_message?: string; prompt_id?: string } | undefined;
        const errMsg = data?.exception_message || 'ComfyUI execution error';
        this.listeners.error.forEach(fn => fn(errMsg));
        break;
      }
    }
  }

  // ─── Event Listeners ───────────────────────────────────────────────────────

  onProgress(fn: ProgressListener): () => void {
    this.listeners.progress.add(fn);
    return () => { this.listeners.progress.delete(fn); };
  }

  onComplete(fn: CompleteListener): () => void {
    this.listeners.complete.add(fn);
    return () => { this.listeners.complete.delete(fn); };
  }

  onError(fn: ErrorListener): () => void {
    this.listeners.error.add(fn);
    return () => { this.listeners.error.delete(fn); };
  }

  // ─── HTTP API (dual-mode: direct or proxy) ─────────────────────────────────

  /**
   * Fetches a ComfyUI endpoint using either:
   * - Direct mode: browser → ComfyUI (requires CORS on ComfyUI)
   * - Proxy mode: browser → /api/comfy/ → ComfyUI (requires server network access)
   */
  private async apiFetch(path: string, options?: RequestInit): Promise<Response> {
    if (this.useDirect) {
      // Direct mode: browser fetches ComfyUI URL directly
      const url = `${this.comfyUrl}/${path}`;
      return fetch(url, options);
    } else {
      // Proxy mode: route through Next.js API route
      const url = `/api/comfy/${path}`;
      return fetch(url, {
        ...options,
        headers: {
          ...options?.headers,
          'x-comfy-url': this.comfyUrl,
        },
      });
    }
  }

  /** GET /system_stats — Test connection and get system info (8s timeout) */
  async getSystemStats(): Promise<ComfySystemStats> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await this.apiFetch('system_stats', { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Connection failed: HTTP ${res.status}`);
      }
      return res.json();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error('Connection timed out (8s)');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /object_info — Get all installed node class_types */
  async getInstalledNodes(): Promise<string[]> {
    const res = await this.apiFetch('object_info');
    if (!res.ok) {
      throw new Error(`Failed to fetch object_info: HTTP ${res.status}`);
    }
    const data = await res.json() as Record<string, unknown>;
    return Object.keys(data).sort();
  }

  /** POST /upload/image — Upload image to ComfyUI input directory */
  async uploadImage(blob: Blob, filename: string): Promise<string> {
    const form = new FormData();
    form.append('image', blob, filename);

    const res = await this.apiFetch('upload/image', {
      method: 'POST',
      body: form,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Upload failed: HTTP ${res.status} ${errText}`);
    }

    const data = await res.json() as { name: string; subfolder?: string; type?: string };
    return data.name; // ComfyUI returns the actual stored filename
  }

  /** POST /prompt — Submit workflow to execution queue */
  async submitPrompt(workflow: object): Promise<string> {
    const res = await this.apiFetch('prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: workflow,
        client_id: this.clientId,
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: 'Unknown error' })) as {
        error?: string;
        node_errors?: Record<string, unknown>;
      };
      const errMsg = errData.error || JSON.stringify(errData.node_errors) || `HTTP ${res.status}`;
      throw new Error(`Submit failed: ${errMsg}`);
    }

    const data = await res.json() as { prompt_id: string };
    return data.prompt_id;
  }

  /** GET /history/{prompt_id} — Get execution result */
  async getHistory(promptId: string): Promise<ComfyHistoryEntry | null> {
    const res = await this.apiFetch(`history/${promptId}`);
    console.log('[ComfyBridge] getHistory response status:', res.status, res.ok);
    if (!res.ok) return null;

    const raw = await res.text();
    console.log('[ComfyBridge] getHistory raw response:', raw.slice(0, 300));
    try {
      const data = JSON.parse(raw) as Record<string, ComfyHistoryEntry>;
      console.log('[ComfyBridge] getHistory keys:', Object.keys(data));
      return data[promptId] || null;
    } catch (e) {
      console.error('[ComfyBridge] getHistory JSON parse error:', e);
      return null;
    }
  }

  /**
   * GET /history — Get all execution history from ComfyUI server.
   * Returns entries keyed by prompt_id, each containing the full API-format workflow.
   */
  async getAllHistory(): Promise<Record<string, ComfyHistoryEntry>> {
    const res = await this.apiFetch('history');
    if (!res.ok) {
      throw new Error(`Failed to fetch history: HTTP ${res.status}`);
    }
    const data = await res.json() as Record<string, ComfyHistoryEntry>;
    return data;
  }

  /** GET /view?filename=...&type=output — Download output image */
  async downloadOutput(filename: string, subfolder?: string, type: string = 'output'): Promise<Blob> {
    let path = `view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}`;
    if (subfolder) {
      path += `&subfolder=${encodeURIComponent(subfolder)}`;
    }

    const res = await this.apiFetch(path);
    if (!res.ok) {
      throw new Error(`Download failed: HTTP ${res.status}`);
    }

    return res.blob();
  }

  /** POST /interrupt — Interrupt currently running execution */
  async interrupt(): Promise<void> {
    await this.apiFetch('interrupt', { method: 'POST' });
  }

  /** DELETE from queue — Remove a queued (not yet executing) prompt */
  async cancelQueued(promptId: string): Promise<void> {
    await this.apiFetch('queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
    });
  }

  /** Waits for execution to complete for a given prompt_id (via WebSocket) */
  waitForCompletion(promptId: string, timeoutMs = 720_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanupComplete();
        cleanupError();
        reject(new Error('Execution timed out'));
      }, timeoutMs);

      const cleanupComplete = this.onComplete((completedId) => {
        if (completedId === promptId) {
          clearTimeout(timer);
          cleanupComplete();
          cleanupError();
          resolve();
        }
      });

      const cleanupError = this.onError((errMsg) => {
        clearTimeout(timer);
        cleanupComplete();
        cleanupError();
        reject(new Error(errMsg));
      });
    });
  }

  // ─── Getters ───────────────────────────────────────────────────────────────

  get url(): string {
    return this.comfyUrl;
  }

  get id(): string {
    return this.clientId;
  }

  get isWsConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Returns the resolved connection mode after auto-detection. */
  get resolvedMode(): 'direct' | 'proxy' {
    return this.useDirect ? 'direct' : 'proxy';
  }
}
