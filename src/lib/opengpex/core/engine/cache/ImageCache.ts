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
 * ImageCache: A singleton cache for decoded HTMLImageElement objects.
 * Prevents redundant re-loads and re-decodes of image assets during heavy
 * operations like Cut, Copy, and Merge.
 */
class ImageCache {
  private static instance: ImageCache;
  private cache: Map<string, HTMLImageElement> = new Map();
  private pending: Map<string, Promise<HTMLImageElement>> = new Map();
  private listeners: Set<() => void> = new Set();

  private constructor() {}

  static getInstance(): ImageCache {
    if (!ImageCache.instance) {
      ImageCache.instance = new ImageCache();
    }
    return ImageCache.instance;
  }

  public subscribe(callback: () => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notify() {
    this.listeners.forEach(cb => cb());
  }

  /**
   * Retrieves a cached image element.
   */
  get(src: string): HTMLImageElement | undefined {
    return this.cache.get(src);
  }

  /**
   * Retrieves a cached image element, or fetches it asynchronously if not present.
   * Emits notify() when the image is successfully loaded.
   */
  getOrFetch(src: string): HTMLImageElement | undefined {
    if (this.cache.has(src)) {
      return this.cache.get(src);
    }
    
    if (!this.pending.has(src)) {
      const promise = new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          this.cache.set(src, img);
          this.pending.delete(src);
          this.notify();
          resolve(img);
        };
        img.onerror = (e) => {
          this.pending.delete(src);
          reject(e);
        };
        img.src = src;
      });
      this.pending.set(src, promise);
    }
    
    return undefined;
  }

  /**
   * Caches an image element.
   */
  set(src: string, img: HTMLImageElement): void {
    this.cache.set(src, img);
    this.notify();
  }

  /**
   * Clears the cache to free up memory.
   */
  clear(): void {
    this.cache.clear();
    this.pending.clear();
    this.notify();
  }
  
  /**
   * Removes specific item from cache.
   */
  remove(src: string): void {
    this.cache.delete(src);
    this.notify();
  }
}

export const imageCache = ImageCache.getInstance();
