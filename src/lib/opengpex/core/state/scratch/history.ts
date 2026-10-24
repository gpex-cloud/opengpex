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
 * Session history — a store-agnostic undo/redo stack for one scratch session.
 *
 * The stack stores "before" snapshots: the caller records the payload state
 * PRIOR to each gesture (one pointer drag, one discrete edit = one step), and
 * undo() hands back that snapshot so the owner can write it back to its
 * storage (for the scratch slots the session service performs the write-back
 * and keeps the redo bookkeeping consistent).
 *
 * Redo bookkeeping deserves a precise note, because the stack only ever sees
 * "before" snapshots yet redo must restore "after" states. Given recorded
 * befores b1..bn and a live state L, the first undo() pops bn and the caller
 * registers L as its redo counterpart via noteRedo(L). Every subsequent undo
 * pops b(k); the state redo must return for that step is exactly b(k+1) —
 * the snapshot popped by the PREVIOUS undo — so noteRedo is called with the
 * previously popped snapshot. Symmetrically, after a redo() returns a target,
 * the caller registers the just-replaced live state via noteUndo so undoing
 * the redo works. The note* methods deliberately do NOT clear the opposite
 * stack (only record() does).
 *
 * Pure logic: no React, no Redux, no references to any storage. Unit-testable
 * in isolation. This class is an internal implementation detail of the
 * scratch service and is NOT part of its public API.
 */

export const SESSION_HISTORY_MAX_STEPS = 100;

export interface SessionHistory<T> {
  /** Records the PRE-gesture state as one undoable step; clears the redo stack. */
  record(before: T): void;
  /** Returns the snapshot to restore, or null when the undo stack is empty. */
  undo(): T | null;
  /** Returns the snapshot to restore, or null when the redo stack is empty. */
  redo(): T | null;
  /** Registers the replaced live state after a successful undo (redo bookkeeping). */
  noteRedo(current: T): void;
  /** Registers the replaced live state after a successful redo (undo bookkeeping). */
  noteUndo(current: T): void;
  canUndo(): boolean;
  canRedo(): boolean;
  clear(): void;
  readonly size: number;
}

export function createSessionHistory<T>(): SessionHistory<T> {
  let undoStack: T[] = [];
  let redoStack: T[] = [];

  return {
    record(before: T): void {
      undoStack.push(before);
      if (undoStack.length > SESSION_HISTORY_MAX_STEPS) undoStack.shift();
      redoStack = [];
    },

    undo(): T | null {
      return undoStack.pop() ?? null;
    },

    redo(): T | null {
      return redoStack.pop() ?? null;
    },

    noteRedo(current: T): void {
      redoStack.push(current);
    },

    noteUndo(current: T): void {
      undoStack.push(current);
    },

    canUndo(): boolean {
      return undoStack.length > 0;
    },

    canRedo(): boolean {
      return redoStack.length > 0;
    },

    clear(): void {
      undoStack = [];
      redoStack = [];
    },

    get size(): number {
      return undoStack.length;
    },
  };
}
