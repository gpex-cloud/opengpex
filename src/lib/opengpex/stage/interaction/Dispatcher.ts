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

import { InteractionHandler, InteractionEvent } from '@opengpex/editor/core/types';

/**
 * InteractionDispatcher: Interaction dispatcher
 * Manages all interaction handlers (InteractionHandler) and coordinates event dispatching within the gesture lifecycle.
 */
export class InteractionDispatcher {
  private activeHandler: InteractionHandler | null = null;
  private handlers: InteractionHandler[] = [];

  constructor(handlers: InteractionHandler[]) {
    // Sorted from high to low priority, ensuring overlapping areas are handled by high-priority handlers
    this.handlers = [...handlers].sort((a, b) => b.priority - a.priority);
  }

  /**
   * handleStart: Attempts to start an interaction gesture
   * Traverses all handlers; the first whose test() returns true wins and handles subsequent events.
   */
  handleStart(e: InteractionEvent): boolean {
    for (const handler of this.handlers) {
      if (handler.test(e)) {
        this.activeHandler = handler;
        handler.onStart?.(e);
        return true;
      }
    }
    return false;
  }

  /**
   * handleMove: Handles move event
   * Direct dispatch if there is already an active handler.
   */
  handleMove(e: InteractionEvent): boolean {
    if (this.activeHandler) {
      this.activeHandler.onMove?.(e);
      return true;
    }
    return false;
  }

  /**
   * handleEnd: Handles end event
   */
  handleEnd(e: InteractionEvent): unknown {
    if (this.activeHandler) {
      const res = this.activeHandler.onEnd?.(e);
      this.activeHandler = null;
      return res;
    }
    return false;
  }

  /**
   * isActive: Whether there is currently an active interaction handler
   */
  isActive(): boolean {
    return !!this.activeHandler;
  }

  /**
   * getActiveHandlerId: Gets the active handler ID
   */
  getActiveHandlerId(): string | null {
    return this.activeHandler?.id || null;
  }
}
