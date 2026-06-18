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

export interface TabItem {
  id: string;
  label: string;
}

interface TabSwitcherProps {
  tabs: TabItem[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  /** Tab button size preset: 'sm' (compact), 'md' (default), 'lg' (spacious) */
  size?: "sm" | "md" | "lg";
}

const SIZE_CLASSES = {
  sm: "py-2 text-[10px]",
  md: "py-3 text-[11px]",
  lg: "py-4 text-[12px]",
} as const;

/**
 * TabSwitcher: Generic Tab switcher component
 * Style references UserGuidePanel's minimalist mono style tab bar.
 * Controls height via size prop: sm / md / lg.
 */
export default function TabSwitcher({
  tabs,
  activeTab,
  onTabChange,
  size = "md",
}: TabSwitcherProps) {
  return (
    <div className="flex border-b border-[var(--border-subtle)] bg-[var(--bg-stage)]/50 shrink-0 font-mono">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={`flex-1 ${SIZE_CLASSES[size]} font-black uppercase tracking-wider transition-colors cursor-pointer ${
            activeTab === tab.id
              ? "text-indigo-500 border-b-2 border-indigo-500 bg-[var(--bg-panel)]/50"
              : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
