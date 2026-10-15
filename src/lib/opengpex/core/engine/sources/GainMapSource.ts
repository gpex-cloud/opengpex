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
 * GainMapSourceCache — main-thread cache of decoded gain-map payloads, keyed
 * by asset id. The presentation-side sibling of `HighDepthTextureCache`: where
 * that holds the resident f16 master pixels, this holds the low-resolution
 * log2 gain map the view pass samples to reconstruct the HDR rendition
 * (`engine/color/gainMap.ts` owns the math; the engine uploads the map to an
 * r8unorm texture when a gain-eligible frame presents).
 *
 * The map is deliberately NOT persisted with the asset: it is presentation
 * adjunct metadata, re-derivable from the retained source blob in one
 * container parse + one aux item decode (`FileService.decodeGainMap` — the
 * injected fetcher). Contract mirrors `HighDepthTextureCache.getOrFetch`:
 *
 *   - sync hit → the decoded map (or undefined for a negative entry);
 *   - miss → kick the one-shot fetch, return undefined NOW (the presenting
 *     frame renders the authoritative SDR base), `notify()` subscribers when
 *     it lands so the next frame flips bright;
 *   - fetcher null / throw → negative-cached, never re-probed (no HDR for
 *     this asset this session; a re-import starts fresh).
 *
 * No byte budget: gain maps are camera-metadata-scale (≤ a few MB — e.g. the
 * 3024×4032 Apple form is ~12 MB single-channel), bounded by the number of
 * gain-map assets in the session.
 *
 * @module core/engine/sources/GainMapSource
 */

/** Decoded gain map — structurally the files layer's `GainMapData`. */
export interface GainMapSource {
  /** Single-channel quantized samples, 0..255, row-major width × height. */
  readonly map: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Map value at byte 0 (log2 HDR/SDR ratio; may be negative). */
  readonly gainMin: number;
  /** Map value at byte 255 (log2 HDR/SDR ratio). */
  readonly gainMax: number;
  /** Payload gamma (1 = log2-linear). */
  readonly gamma: number;
}

export type GainMapFetcher = (assetId: string) => Promise<GainMapSource | null>;

class GainMapSourceCache {
  private cache: Map<string, GainMapSource | null> = new Map();
  private pending: Map<string, Promise<GainMapSource | null>> = new Map();
  private listeners: Set<() => void> = new Set();

  /** Subscription (mirrors HighDepthTextureCache: late decode → redraw). */
  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb());
  }

  /** Sync lookup — the decoded map, or undefined (missing OR negative). */
  get(assetId: string): GainMapSource | undefined {
    const entry = this.cache.get(assetId);
    return entry === null ? undefined : entry;
  }

  /**
   * Direct warm: land a decoded payload synchronously (test seeding today;
   * import-time prewarming later). Notifies like any positive landing so
   * subscribers redraw.
   */
  set(assetId: string, source: GainMapSource): void {
    this.cache.set(assetId, source);
    this.notify();
  }

  /**
   * Sync-return + async-fetch: cached value (positive or negative) returns
   * immediately; a miss kicks `fetcher` once (in-flight dedup) and notifies
   * subscribers only when a map lands.
   */
  getOrFetch(assetId: string, fetcher: GainMapFetcher): GainMapSource | undefined {
    const hit = this.cache.get(assetId);
    if (hit !== undefined) return hit === null ? undefined : hit;
    if (this.pending.has(assetId)) return undefined;

    const promise = fetcher(assetId);
    this.pending.set(assetId, promise);
    promise.then(
      (source) => {
        if (this.pending.get(assetId) !== promise) return;
        this.pending.delete(assetId);
        this.cache.set(assetId, source); // positive entry, or null = negative
        if (source) this.notify(); // only a positive result changes the picture
      },
      (err) => {
        if (this.pending.get(assetId) === promise) {
          this.pending.delete(assetId);
          this.cache.set(assetId, null); // failed fetch = negative, one-shot
        }
        console.warn('[GainMapSourceCache] decode failed for', assetId, err);
      },
    );
    return undefined;
  }

  delete(assetId: string): void {
    this.cache.delete(assetId);
    this.pending.delete(assetId);
  }

  clear(): void {
    this.cache.clear();
    this.pending.clear();
  }
}

export const gainMapSourceCache = new GainMapSourceCache();
