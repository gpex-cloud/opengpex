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
 * AsyncHandler Factory — Shared pattern for async interaction handlers.
 *
 * Encapsulates the common busy-guard + discard pattern used by SAM, Wand,
 * and similar "click → async compute → commit result" handlers.
 *
 * Features:
 * - Automatic busy-guard: reentrant clicks show feedback instead of double-executing.
 * - Discard support: if a new gesture starts while async work is in-flight, the
 *   pending result can be discarded via `isDiscarded()` check.
 * - onCancel integration: Esc key properly clears busy state and signals discard.
 *
 * This factory is parallel to `createTransformHandler` — it handles the "click-to-compute"
 * paradigm rather than the "drag-to-transform" paradigm.
 */

import type { InteractionHandler, InteractionEvent } from '@opengpex/editor/core/types';

// ─── Config Interface ──────────────────────────────────────────────────────────

export interface AsyncHandlerConfig {
  /** Unique handler identifier */
  id: string;
  /** Priority in the dispatcher's handler queue */
  priority: number;

  /**
   * Test whether this handler should activate for the given event.
   * Return true to claim the interaction.
   */
  test: (e: InteractionEvent) => boolean;

  /**
   * Called on pointer down (optional). Use for capturing start position, etc.
   */
  onStart?: (e: InteractionEvent) => void;

  /**
   * Called on pointer move while active (optional). Use for drag preview, etc.
   */
  onMove?: (e: InteractionEvent) => void;

  /**
   * The main async execution logic, called on pointer up.
   *
   * Receives a context object with:
   * - `e`: the interaction event at pointer-up time
   * - `isDiscarded()`: check if a cancel/new-gesture has invalidated this execution
   *
   * The handler should periodically check `isDiscarded()` during long operations
   * and bail out early if true.
   */
  execute: (e: InteractionEvent, ctx: AsyncExecutionContext) => Promise<void>;

  /**
   * Called when the handler is busy and a new interaction attempt arrives.
   * Use for user feedback (e.g., error pulse animation).
   * If not provided, busy re-entry is silently ignored.
   */
  onBusy?: (e: InteractionEvent) => void;

  /**
   * Called when the interaction is cancelled (e.g., Esc key) while idle (not busy).
   * Use for cleanup like clearing selections.
   * Note: If cancelled while busy, the `isDiscarded()` flag is set instead.
   */
  onCancel?: (e: InteractionEvent) => void;
}

export interface AsyncExecutionContext {
  /** Returns true if the execution has been invalidated (user cancelled or new gesture started) */
  isDiscarded: () => boolean;
}

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates an InteractionHandler that wraps async "click-to-compute" logic
 * with automatic busy-guard and discard management.
 */
export function createAsyncHandler(config: AsyncHandlerConfig): InteractionHandler {
  let busy = false;
  let discardPending = false;

  return {
    id: config.id,
    priority: config.priority,

    test: (e) => config.test(e),

    onStart: (e) => {
      config.onStart?.(e);
    },

    onMove: (e) => {
      config.onMove?.(e);
    },

    onEnd: (e) => {
      if (busy) {
        config.onBusy?.(e);
        return;
      }

      busy = true;
      discardPending = false;

      const ctx: AsyncExecutionContext = {
        isDiscarded: () => discardPending,
      };

      return (async () => {
        try {
          await config.execute(e, ctx);
        } catch (err) {
          if (!discardPending) {
            console.error(`[AsyncHandler:${config.id}] execute() failed:`, err);
          }
        } finally {
          busy = false;
        }
      })();
    },

    onCancel: (e) => {
      if (busy) {
        // Signal discard to the in-flight execution
        discardPending = true;
      } else {
        config.onCancel?.(e);
      }
    },
  };
}
