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
 * Scratch slots — per-frame, per-tool draft payloads.
 *
 * The storage is owned by this service (plain object maps); it deliberately
 * does NOT live in VolatileState and shares nothing with the volatile module:
 * the volatile fast-track exists to merge interaction drafts into Redux on
 * commit and carries GC/interacting semantics the scratch payloads must not
 * trip, while scratch slots are plain "hold my work-in-progress" boxes that
 * die with the page (never persisted).
 *
 * Payload contract: serializable pure JSON, self-contained geometry. Blobs,
 * ImageBitmaps and live object references are forbidden — a slot payload may
 * travel through undo snapshots, which must stay structurally cloneable.
 *
 * Every write (set, clear, and the session service's undo/redo write-backs)
 * bumps the version counter so overlay repaint loops can dirty-check cheaply.
 */

export interface ScratchSlots {
  get(frameId: string, slotId: string): unknown | undefined;
  /** Pure write, never enters any undo stack; bumps version. */
  set(frameId: string, slotId: string, payload: unknown): void;
  clear(frameId: string, slotId: string): void;
  /** Monotonic counter bumped on every slot write (dirty-check for overlays). */
  version(): number;
}

/** Teardown-only extensions used by the session service's housekeeping. */
export interface ScratchSlotsInternal extends ScratchSlots {
  /** Removes every slot of the given frame; bumps version when something was removed. */
  clearFrame(frameId: string): void;
  /** Removes every slot of every frame; bumps version when something was removed. */
  reset(): void;
}

export function createScratchSlots(): ScratchSlotsInternal {
  // frameId → slotId → payload
  const store = new Map<string, Map<string, unknown>>();
  let versionCounter = 0;

  return {
    get(frameId: string, slotId: string): unknown | undefined {
      return store.get(frameId)?.get(slotId);
    },

    set(frameId: string, slotId: string, payload: unknown): void {
      let frameSlots = store.get(frameId);
      if (!frameSlots) {
        frameSlots = new Map();
        store.set(frameId, frameSlots);
      }
      frameSlots.set(slotId, payload);
      versionCounter++;
    },

    clear(frameId: string, slotId: string): void {
      if (store.get(frameId)?.delete(slotId)) versionCounter++;
    },

    clearFrame(frameId: string): void {
      if (store.delete(frameId)) versionCounter++;
    },

    reset(): void {
      if (store.size > 0) versionCounter++;
      store.clear();
    },

    version(): number {
      return versionCounter;
    },
  };
}
