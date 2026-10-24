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
 * Scratch session arbitration — the active-session table and the undo/redo
 * takeover primitive consumed by `actions.history`.
 *
 * Model:
 * - One active session per frame at most, owned by exactly one tool.
 *   `begin` on a frame that already holds a session THROWS — a session leak
 *   (a tool forgetting to end) must surface loudly, not silently stack.
 * - Sessions survive frame switches: switching away suspends the session
 *   (its slot and stack stay untouched); switching back resumes it. The tool
 *   itself ends the session on commit / discard / deactivation — the
 *   component never guesses tool semantics.
 * - `undoAt` / `redoAt` are the single funnel `actions.history` consults
 *   before falling through to the global dispatcher. They perform the
 *   session stack pop AND the slot write-back (bumping the slot version so
 *   overlays repaint), and report 'empty' when the session stack cannot
 *   serve the step so the caller can fence the global history with a HUD
 *   hint instead of letting an undo slip past the live session.
 */

import { createSessionHistory, type SessionHistory } from './history';
import { createScratchSlots, type ScratchSlotsInternal } from './slots';

/** Outcome of a session-scoped undo/redo attempt. */
export type ScratchTakeoverResult =
  | 'performed'  // the session stack served the step; slot already written back
  | 'empty'      // a session is active but its stack cannot serve the step (caller shows the fence hint)
  | 'inactive';  // no session on this frame (caller falls through to global history)

/** What an active session exposes to the history takeover point. */
export interface ActiveScratchSession {
  ownerToolId: string;
  slotId: string;
  history: SessionHistory<unknown>;
}

export interface ScratchSession {
  /** Opens a session for the frame; throws when the frame already has one. */
  begin(frameId: string, ownerToolId: string, slotId: string): void;
  /** Clears the session's stacks and releases the frame's active slot. */
  end(frameId: string): void;
  /** The frame's active session, or null. */
  active(frameId: string): ActiveScratchSession | null;
}

export interface ScratchService {
  slots: ScratchSlotsInternal;
  session: ScratchSession;
  /**
   * Session-scoped undo for the given frame: pops the stack, writes the
   * snapshot back to the slot (bumping the version) and keeps the redo
   * bookkeeping. Never touches global history.
   */
  undoAt(frameId: string): ScratchTakeoverResult;
  /** Symmetric counterpart of {@link undoAt}. */
  redoAt(frameId: string): ScratchTakeoverResult;
  /** Forwards a PRE-gesture snapshot to the frame's session stack (no-op without one). */
  record(frameId: string, before: unknown): void;
  /** Removes slots and sessions for the given frames (REMOVE_FRAME housekeeping). */
  cleanup(frameIds: string[]): void;
  /** Wipes every slot and session (clear-all-data housekeeping). */
  reset(): void;
}

interface SessionEntry {
  ownerToolId: string;
  slotId: string;
  history: SessionHistory<unknown>;
}

export function createScratchService(): ScratchService {
  const slots = createScratchSlots();
  // frameId → active session
  const sessions = new Map<string, SessionEntry>();

  const session: ScratchSession = {
    begin(frameId: string, ownerToolId: string, slotId: string): void {
      const existing = sessions.get(frameId);
      if (existing) {
        throw new Error(
          `Scratch session already active on frame "${frameId}" (owner "${existing.ownerToolId}"); ` +
          'the owning tool must end it before a new session can begin.',
        );
      }
      sessions.set(frameId, { ownerToolId, slotId, history: createSessionHistory<unknown>() });
    },

    end(frameId: string): void {
      sessions.get(frameId)?.history.clear();
      sessions.delete(frameId);
    },

    active(frameId: string): ActiveScratchSession | null {
      return sessions.get(frameId) ?? null;
    },
  };

  const takeover = (frameId: string, direction: 'undo' | 'redo'): ScratchTakeoverResult => {
    const entry = sessions.get(frameId);
    if (!entry) return 'inactive';

    const snap = direction === 'undo' ? entry.history.undo() : entry.history.redo();
    if (snap === null) return 'empty';

    // Redo bookkeeping: the state this step just replaced becomes the
    // opposite stack's restore target (see history.ts for the exact model).
    const current = slots.get(frameId, entry.slotId);
    if (direction === 'undo') entry.history.noteRedo(current);
    else entry.history.noteUndo(current);

    slots.set(frameId, entry.slotId, snap);
    return 'performed';
  };

  return {
    slots,
    session,
    undoAt: (frameId) => takeover(frameId, 'undo'),
    redoAt: (frameId) => takeover(frameId, 'redo'),
    record(frameId, before) {
      sessions.get(frameId)?.history.record(before);
    },
    cleanup(frameIds) {
      frameIds.forEach((fid) => {
        session.end(fid);
        slots.clearFrame(fid);
      });
    },
    reset() {
      sessions.forEach((_entry, fid) => session.end(fid));
      slots.reset();
    },
  };
}
