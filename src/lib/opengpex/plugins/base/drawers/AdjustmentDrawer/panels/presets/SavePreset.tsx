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

"use client";

import { Check, X } from "lucide-react";

// ─── SavePreset ───────────────────────────────────────────────────────────────

/**
 * The inline name-entry row for "Save as Preset": the text field plus the
 * trailing confirm (check) and cancel (X) buttons. Extracted as a standalone
 * component so the interaction contract — Enter/blur commits, Escape cancels
 * WITHOUT letting the event reach the document-level craft-tool handlers,
 * and button presses never blur-commit before their click lands — is
 * testable headlessly.
 */
export function SavePreset({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-0.5 shrink-0">
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCommit();
          if (e.key === 'Escape') {
            // Consume the event before it bubbles to the document: the
            // active craft overlays listen for Escape at the document level
            // to deactivate the tool, and a name edit must not eject it.
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        onBlur={onCommit}
        aria-label="Preset name"
        placeholder="Custom Look"
        className="flex-1 min-w-0 h-5 px-1.5 rounded-md text-[9px] font-bold bg-[var(--bg-stage)] border border-indigo-500/40 outline-none focus:border-indigo-500/60 text-[var(--text-primary)]"
      />
      {/* Trailing confirm/cancel. mousedown is swallowed so pressing a
          button never blurs the input first — blur commits, which would run
          before the click and double-fire. */}
      <button
        type="button"
        data-testid="save-preset-confirm"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onCommit}
        aria-label="Confirm preset name"
        title="Save preset"
        className="w-5 h-5 flex items-center justify-center rounded-md text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10 outline-none focus:outline-none shrink-0"
      >
        <Check size={10} strokeWidth={3} />
      </button>
      <button
        type="button"
        data-testid="save-preset-cancel"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onCancel}
        aria-label="Cancel preset name"
        title="Cancel"
        className="w-5 h-5 flex items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-zinc-500/10 hover:text-[var(--text-main)] outline-none focus:outline-none shrink-0"
      >
        <X size={10} strokeWidth={3} />
      </button>
    </div>
  );
}
