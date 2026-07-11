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

/**
 * ActionGroup — a segmented row of icon-only toggle buttons.
 *
 * Companion to `ActionButton` (which is a single standalone action). Where
 * ActionButton is used for one-shot commands (Reset, Save, Import), ActionGroup
 * is the drawer-header "sub-panel switcher" pattern used across the editor
 * (e.g. AdjustmentDrawer's Basic/Curves/Levels/Mixer picker, CraftDrawer's
 * Text/Brush/Eraser picker). Extracted here so we have ONE place to enforce
 * the visual conventions:
 *
 *   - fixed 20px group height (`h-5`), 24px per button (`w-6`), 1px dividers
 *     between buttons — matches the compact drawer-title aesthetic.
 *   - neutral (achromatic) selection style: filled gray card + inset gray ring,
 *     no colored accent, no bottom underline.
 *   - focus ring suppressed via triple-defense (Tailwind utilities, inline
 *     `outline: none`, and a mousedown-blur handler) so mouse-click doesn't
 *     leave a lingering UA outline while still allowing keyboard Tab focus.
 *
 * Dynamic per-item content (icon swap, label swap based on parent state) is
 * handled at the call site: `items` are rebuilt every render, so each entry's
 * `icon` / `label` can be a plain function of the parent's state. Example:
 * CraftDrawer swaps the eraser button's icon to `<Undo2/>` when the tool is
 * in `restore` sub-mode by simply computing the icon at map time — the widget
 * itself has no `renderIcon` slot and stays presentational.
 *
 * State model: buttons are strictly two-state (`active | default`). Earlier
 * iterations experimented with a third "inferred" state (dot indicator for
 * "has content but not selected"), but that UX turned out to be more noisy
 * than useful — every fresh layer's identity-value adjustments would trip
 * the dot on Basic, and users didn't ask for the extra signal. If a future
 * feature genuinely needs a third state, add it opt-in via a new prop
 * rather than resurrecting the tri-state default.
 *
 * ─── Example ──────────────────────────────────────────────────────────────
 * ```tsx
 * <ActionGroup
 *   items={[
 *     { key: 'basic', icon: <Sliders size={10} />, label: 'Basic', active: tool === 'basic' },
 *     ...
 *   ]}
 *   onSelect={(key) => selectTool(key)}
 * />
 * ```
 */

import React from "react";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ActionGroupItem<K extends string = string> {
  /** Stable identifier passed to `onSelect`. Also used as the React key. */
  key: K;
  /** Icon node — typically a lucide icon at ~10px. */
  icon: React.ReactNode;
  /** Tooltip / accessible label shown on hover. */
  label: string;
  /** Whether this button is the currently-selected one in the group. */
  active: boolean;
}

export interface ActionGroupProps<K extends string = string> {
  items: readonly ActionGroupItem<K>[];
  onSelect: (key: K) => void;
  /** Extra classes on the outer wrapper — e.g. for margin/gap tuning. */
  className?: string;
}

// ─── Component ────────────────────────────────────────────────────────────

export default function ActionGroup<K extends string = string>({
  items,
  onSelect,
  className = "",
}: ActionGroupProps<K>) {
  return (
    <div
      className={`flex items-center h-5 rounded-md overflow-hidden border border-[var(--border-subtle)] ${className}`}
    >
      {items.map((item, index) => {
        const { key, icon, label, active } = item;
        return (
          <React.Fragment key={key}>
            {/* 1px vertical divider between adjacent buttons. Uses the same
                zinc-300/white-10 tokens as the parent border for a seamless
                "segmented control" look. */}
            {index > 0 && (
              <div className="w-[1px] h-2.5 bg-zinc-300/50 dark:bg-white/10 shrink-0" />
            )}
            <button
              onClick={() => onSelect(key)}
              // Two-state class ladder:
              //   active  -> gray fill + inset gray ring + main text color
              //   default -> muted text + hover-stage bg + hover-brighten
              className={`relative flex items-center justify-center w-6 h-full transition-all outline-none select-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0
                ${
                  active
                    ? "text-[var(--text-main)] bg-zinc-200 dark:bg-white/10 ring-1 ring-inset ring-zinc-400/60 dark:ring-white/25"
                    : "hover:bg-[var(--bg-stage)] text-[var(--text-muted)] hover:text-[var(--text-main)]"
                }`}
              // Triple-defense against the UA "click-focus outline":
              //   1. Tailwind classes above zero out :focus / :focus-visible
              //      outline + ring.
              //   2. Inline `outline: none` guards against any UA shorthand
              //      that Tailwind reset misses (macOS Chromium quirk).
              //   3. `onMouseDown` blur so the button doesn't retain :focus
              //      after mouse-click. Keyboard Tab focusing still works
              //      because Tab arrives via keydown, not mousedown.
              style={{
                WebkitTapHighlightColor: "transparent",
                outline: "none",
              }}
              onMouseDown={(e) => {
                e.currentTarget.blur();
              }}
              title={label}
              aria-label={label}
              aria-pressed={active}
            >
              {icon}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}
