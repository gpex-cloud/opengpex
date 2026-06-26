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
 * ResourceTracker: Lightweight standalone singleton for application-level memory tracking.
 *
 * Unlike browser APIs (performance.memory), this tracker provides visibility into
 * what the APPLICATION itself is allocating, not just what the JS engine reports.
 *
 * Usage:
 *   import { resourceTracker } from '@opengpex/editor/core/advanced/ResourceTracker';
 *   resourceTracker.track('undo-snapshot-12', 'undo_snapshot', buffer.byteLength);
 *   resourceTracker.release('undo-snapshot-12');
 */

export type MemCategory =
  | 'image_decoded'     // Decoded pixel data (w × h × 4)
  | 'image_cache'       // OffscreenCanvas / ImageBitmap caches
  | 'undo_snapshot'     // Undo stack snapshot data
  | 'canvas_buffer'     // Tiled rendering buffers
  | 'worker_transfer'   // ArrayBuffers transferred to/from workers
  | 'misc';             // Other allocations

export interface Allocation {
  id: string;
  category: MemCategory;
  bytes: number;
  ts: number;
  label?: string;       // Optional human-readable label
}

export interface CategorySummary {
  count: number;
  bytes: number;
}

export interface ResourceSummary {
  totalBytes: number;
  totalCount: number;
  byCategory: Partial<Record<MemCategory, CategorySummary>>;
  top5: Allocation[];
}

class ResourceTrackerService {
  private allocations = new Map<string, Allocation>();

  /**
   * Register a new memory allocation.
   */
  track(id: string, category: MemCategory, bytes: number, label?: string): void {
    this.allocations.set(id, { id, category, bytes, ts: Date.now(), label });
  }

  /**
   * Release a previously tracked allocation.
   */
  release(id: string): void {
    this.allocations.delete(id);
  }

  /**
   * Check if an allocation exists.
   */
  has(id: string): boolean {
    return this.allocations.has(id);
  }

  /**
   * Update the byte count for an existing allocation (e.g., buffer resize).
   */
  update(id: string, bytes: number): void {
    const existing = this.allocations.get(id);
    if (existing) {
      existing.bytes = bytes;
      existing.ts = Date.now();
    }
  }

  /**
   * Get a complete summary of all tracked resources.
   */
  getSummary(): ResourceSummary {
    let totalBytes = 0;
    let totalCount = 0;
    const byCategory: Partial<Record<MemCategory, CategorySummary>> = {};

    for (const alloc of this.allocations.values()) {
      totalBytes += alloc.bytes;
      totalCount++;

      if (!byCategory[alloc.category]) {
        byCategory[alloc.category] = { count: 0, bytes: 0 };
      }
      byCategory[alloc.category]!.count++;
      byCategory[alloc.category]!.bytes += alloc.bytes;
    }

    // Top 5 largest allocations
    const top5 = [...this.allocations.values()]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 5);

    return { totalBytes, totalCount, byCategory, top5 };
  }

  /**
   * Get total tracked bytes.
   */
  getTotalBytes(): number {
    let total = 0;
    for (const alloc of this.allocations.values()) {
      total += alloc.bytes;
    }
    return total;
  }

  /**
   * Clear all tracking data.
   */
  clear(): void {
    this.allocations.clear();
  }

  /**
   * Get allocation count.
   */
  get size(): number {
    return this.allocations.size;
  }
}

/**
 * Global singleton instance.
 * Import this wherever you need to track resource allocations.
 */
export const resourceTracker = new ResourceTrackerService();
