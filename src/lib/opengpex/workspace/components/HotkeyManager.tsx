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

import { useEffect } from "react";
import { useEditorServices } from "@opengpex/editor/core/context";

/**
 * HotkeyManager: Global hotkey dispatch center
 * Core responsibility: Listen to keyboard events, match against registry, and dispatch actions.
 * Avoid typing conflicts: block hotkeys when inputting in Input/Textarea.
 */
export default function HotkeyManager() {
  const { plugins, actions } = useEditorServices();

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

        e.preventDefault();

        shortcut.action();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [plugins, actions]);

  return null; // Logic-only component, no UI
}
