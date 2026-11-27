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
 * EngineContentCache.ts — Unified cross-frame GPU content cache service.
 *
 * Centralizes namespaced content-keyed GPU caches (vmask, confinement,
 * bmask-combine, adjust coverage arrays, EDT seed textures) under a single
 * device-scoped lifecycle so `WebGpuEngine` can tear down all cross-frame
 * pass caches with one `clear()` call instead of importing per-pass helpers.
 *
 * @module core/gpu/resources/EngineContentCache
 */

export interface ContentCacheNamespaceSpec<T> {
  readonly dispose: (entry: T) => void;
  readonly onClear?: () => void;
}

export interface ContentCacheNamespace<T> {
  get(device: GPUDevice, key: string): T | undefined;
  set(device: GPUDevice, key: string, value: T): T;
  delete(key: string): void;
  sweep(seen: ReadonlySet<string>, prefix?: string): void;
  clear(): void;
}

interface InternalNamespace {
  clear(): void;
}

export class EngineContentCache {
  private device: GPUDevice | null = null;
  private readonly namespaces = new Map<string, InternalNamespace>();

  ensureDevice(device: GPUDevice): void {
    if (this.device !== null && this.device !== device) {
      this.clear();
    }
    this.device = device;
  }

  namespace<T>(name: string, spec: ContentCacheNamespaceSpec<T>): ContentCacheNamespace<T> {
    const entries = new Map<string, T>();

    const ns: ContentCacheNamespace<T> = {
      get: (device, key) => {
        this.ensureDevice(device);
        return entries.get(key);
      },
      set: (device, key, value) => {
        this.ensureDevice(device);
        const prev = entries.get(key);
        if (prev !== undefined && prev !== value) {
          spec.dispose(prev);
        }
        entries.set(key, value);
        return value;
      },
      delete: (key) => {
        const prev = entries.get(key);
        if (prev !== undefined) {
          spec.dispose(prev);
          entries.delete(key);
        }
      },
      sweep: (seen, prefix) => {
        for (const [key, entry] of entries) {
          if (prefix && !key.startsWith(prefix)) continue;
          if (!seen.has(key)) {
            spec.dispose(entry);
            entries.delete(key);
          }
        }
      },
      clear: () => {
        for (const entry of entries.values()) {
          spec.dispose(entry);
        }
        entries.clear();
        spec.onClear?.();
      },
    };

    this.namespaces.set(name, ns);
    return ns;
  }

  register(name: string, clear: () => void): void {
    this.namespaces.set(name, { clear });
  }

  clear(): void {
    for (const ns of this.namespaces.values()) {
      ns.clear();
    }
    this.device = null;
  }
}

export const engineContentCache = new EngineContentCache();
