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

import { InteractionHandler, InteractionEvent, SpringChannel } from '@opengpex/editor/core/types';

/**
 * InteractionDispatcher: Interaction dispatcher
 * Manages all interaction handlers (InteractionHandler) and coordinates event dispatching within the gesture lifecycle.
 */
export class InteractionDispatcher {
  private activeHandler: InteractionHandler | null = null;
  private handlers: InteractionHandler[] = [];
  private lastEvent: InteractionEvent | null = null;

  constructor(handlers: InteractionHandler[]) {
    // Sorted from high to low priority, ensuring overlapping areas are handled by high-priority handlers
    this.handlers = [...handlers].sort((a, b) => b.priority - a.priority);
  }

  /**
   * handleStart: Attempts to start an interaction gesture
   * Traverses all handlers; the first whose test() returns true wins and handles subsequent events.
   */
  handleStart(e: InteractionEvent): boolean {
    this.lastEvent = e;
    const button = (e.nativeEvent as MouseEvent).button;

    // ── Global reservation: middle-click (1) and right-click (2) always route
    //    directly to viewport-pan, bypassing all other handler priority checks.
    //    This prevents accidental layer-move / tool activation and avoids
    //    needing per-handler button exclusion scattered across the codebase.
    if (button === 1 || button === 2) {
      const panHandler = this.handlers.find(h => h.id === 'viewport-pan');
      if (panHandler) {
        this.activeHandler = panHandler;
        panHandler.onStart?.(e);
        return true;
      }
    }

    // ── Spring keys: an ENGAGED ROUTING channel (held, not suppressed) means
    //    "move the object under the pointer". While such a channel is engaged,
    //    only handlers that declare a springOverride on one of the engaged
    //    channels (tool-specific semantics such as selection peel) plus the
    //    global layer-move fallback are consulted — every other handler is
    //    treated as nonexistent, so craft tools cannot swallow the press and
    //    the global temporary-move holds in any mode without per-tool
    //    cooperation.
    //
    //    Only ROUTING channels filter the chain. Shift is deliberately
    //    excluded: every shift consumer in the codebase (aspect toggle,
    //    angle snap, draw constraint, snap bypass, boolean union) reads the
    //    raw event bit inside an already-bound gesture — shift is a pure
    //    in-gesture modifier, never a reroute. Registering it as a spring
    //    channel (blur-safe state + cursor display) must not also hide every
    //    handler from a shift-first press, which silently killed resize /
    //    draw / paint gestures started while Shift was already held.
    const ROUTING_CHANNELS: ReadonlySet<string> = new Set<SpringChannel>(['meta', 'alt']);
    const engagedChannels = (Object.keys(e.spring) as SpringChannel[]).filter(
      (channel) => e.spring[channel] && ROUTING_CHANNELS.has(channel),
    );

    for (const handler of this.handlers) {
      const overrideChannels = handler.springOverride === undefined
        ? []
        : Array.isArray(handler.springOverride)
          ? handler.springOverride
          : [handler.springOverride];
      const overridesEngaged = overrideChannels.some((channel) => engagedChannels.includes(channel));
      if (engagedChannels.length > 0 && !overridesEngaged && handler.id !== 'layer-move') continue;
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
      this.lastEvent = e;
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
      this.lastEvent = null;
      return res;
    }
    return false;
  }

  /**
   * cancelAll: Cancel the active interaction gesture.
   * Calls the active handler's onCancel (if implemented) and clears the active session.
   * Used when user presses Esc or other external cancellation triggers.
   */
  cancelAll(): void {
    if (!this.activeHandler) return;

    if (this.lastEvent) {
      this.activeHandler.onCancel?.(this.lastEvent);
    }
    this.activeHandler = null;
    this.lastEvent = null;
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
