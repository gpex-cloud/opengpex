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

import { useEffect, useRef } from "react";
import { useEditorServices } from "@opengpex/editor/core/context";

/**
 * HotkeyManager: Global hotkey dispatch center
 * Core responsibility: Listen to keyboard events, match against registry, and dispatch actions.
 *
 * ─── Multi-tap support (2026-06-23) ───────────────────────────────────────
 * Shortcuts may declare `taps: N` (default 1). When N > 1 the same key (with
 * matching modifier set) must be pressed N times within `tapWindowMs`
 * (default 400ms) of each other to fire. Why this matters:
 *   1) some idiomatic gestures (e.g. "double-tap A to toggle anti-alias")
 *      are too noisy as single-key bindings — A on its own collides with
 *      navigation / selection idioms;
 *   2) keeps this concern declarative, alongside other shortcut metadata,
 *      so plugins don't each invent their own local `useEffect` to listen
 *      for keydown and roll a custom timer (prior to this refactor the AA
 *      toggle did exactly that — ~60 LoC moved into here as ~20 LoC of
 *      reusable infra).
 *
 * Intermediate presses are `preventDefault`-ed so a half-completed gesture
 * doesn't leak into other listeners (browser find, form fields, …). The
 * tap counter is keyed by `shortcut.id` so two independent multi-tap
 * shortcuts on different keys don't share state.
 *
 * Auto-repeat (`KeyboardEvent.repeat`) is rejected for multi-tap matches
 * so holding a key down can't be interpreted as many fast taps.
 *
 * Avoid typing conflicts: block hotkeys when inputting in Input/Textarea.
 */
export default function HotkeyManager() {
  const { plugins, actions } = useEditorServices();

  // Per-shortcut tap state. Lives in a ref because it mutates on every
  // qualifying keystroke and never needs to flow into JSX.
  //   { count: number of taps already accumulated in the current window;
  //     lastAt: performance.now() of the previous tap }
  const tapStateRef = useRef<Map<string, { count: number; lastAt: number }>>(new Map());

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 1. Avoid input fields (Avoid triggering when typing in inputs)
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      // 2. Match hotkey
      const allShortcuts = plugins.getAllShortcuts();
      const shortcut = allShortcuts.find((s) => {
        const keyMatch = s.key.toLowerCase() === e.key.toLowerCase();
        const ctrlMatch = (s.ctrl ?? false) === e.ctrlKey;
        const metaMatch = (s.meta ?? false) === e.metaKey;
        const shiftMatch = (s.shift ?? false) === e.shiftKey;
        const altMatch = (s.alt ?? false) === e.altKey;

        return keyMatch && ctrlMatch && metaMatch && shiftMatch && altMatch;
      });

      if (shortcut) {
        const isPasteAction =
          shortcut.key.toLowerCase() === "v" && (e.ctrlKey || e.metaKey);

        if (isPasteAction) {
          // Do not block default behavior, do not manually execute command
          // Let browser fire native 'paste' event, handled by PasteHandler
          return;
        }

        // [New] Smart avoidance mechanism:
        const selection = window.getSelection()?.toString();
        const isSystemConflict = ["c", "v", "x", "a"].includes(
          e.key.toLowerCase(),
        );
        const hasModifier = e.ctrlKey || e.metaKey;

        if (selection && isSystemConflict && hasModifier) {
          return; // Fall through to native browser behavior
        }

        const requiredTaps = shortcut.taps ?? 1;

        // ─── Single-tap fast path ──────────────────────────────────────
        // Default case. Preserves the pre-refactor behaviour byte-for-byte
        // so already-registered shortcuts (Esc, ⌘Z, …) are unaffected.
        if (requiredTaps <= 1) {
          e.preventDefault();
          shortcut.action();
          return;
        }

        // ─── Multi-tap path ────────────────────────────────────────────
        // OS auto-repeat must never count: 1 physical press would
        // otherwise generate enough repeats to fire arbitrarily many
        // multi-taps within the window.
        if (e.repeat) return;

        const now = performance.now();
        const win = shortcut.tapWindowMs ?? 400;
        const prev = tapStateRef.current.get(shortcut.id);
        const fresh = !prev || now - prev.lastAt > win;
        const count = fresh ? 1 : prev!.count + 1;

        // Always swallow intermediate keystrokes — once the user has
        // committed to the multi-tap path, partial gestures shouldn't
        // leak to other handlers. (We've already filtered modifier
        // conflicts above via `getSelection() && hasModifier`.)
        e.preventDefault();

        if (count >= requiredTaps) {
          tapStateRef.current.delete(shortcut.id);
          shortcut.action();
        } else {
          tapStateRef.current.set(shortcut.id, { count, lastAt: now });
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [plugins, actions]);

  return null; // Logic-only component, no UI
}
