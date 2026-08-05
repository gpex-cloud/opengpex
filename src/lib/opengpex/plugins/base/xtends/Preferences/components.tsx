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

'use client';

import React from 'react';
import { Mouse, Scissors, Move } from 'lucide-react';
import Switch from '@opengpex/editor/widgets/Switch';
import { usePreset } from '@opengpex/editor/core/helpers/preferences/usePreset';
import { presets } from '@opengpex/editor/core/helpers/preferences';
import { PRESET_MANIFEST, type PresetManifestEntry } from '@opengpex/editor/core/helpers/preferences/whitelist';

// ─── Icon Registry ────────────────────────────────────────────────────────────
// Maps `groupIcon` string in manifest to actual Lucide component.

const ICON_MAP: Record<string, React.ComponentType<{ size?: number }>> = {
  Mouse,
  Scissors,
  Move,
};

// ─── Grouped Manifest ─────────────────────────────────────────────────────────

interface ManifestGroup {
  name: string;
  icon?: React.ComponentType<{ size?: number }>;
  entries: PresetManifestEntry[];
}

function getGroupedManifest(): ManifestGroup[] {
  const groupMap = new Map<string, ManifestGroup>();

  for (const entry of PRESET_MANIFEST) {
    let group = groupMap.get(entry.group);
    if (!group) {
      group = {
        name: entry.group,
        icon: entry.groupIcon ? ICON_MAP[entry.groupIcon] : undefined,
        entries: [],
      };
      groupMap.set(entry.group, group);
    }
    group.entries.push(entry);
  }

  // Sort entries within each group by order
  for (const group of groupMap.values()) {
    group.entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  return Array.from(groupMap.values());
}

// ─── Individual Control Renderers ─────────────────────────────────────────────

function SwitchControl({ entry }: { entry: PresetManifestEntry }) {
  const value = usePreset(entry.key);
  const { switchMap } = entry;

  const isOn = switchMap
    ? value === switchMap.onValue
    : !!value;

  const description = entry.descriptionFn
    ? entry.descriptionFn(value)
    : entry.description;

  const handleToggle = (checked: boolean) => {
    if (switchMap) {
      presets.set(entry.key, (checked ? switchMap.onValue : switchMap.offValue) as never);
    } else {
      presets.set(entry.key, checked as never);
    }
  };

  return (
    <div className="flex items-center justify-between rounded-xl p-3 bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
      <div className="flex flex-col gap-0.5">
        <span className="text-[11px] font-semibold text-[var(--text-main)]">
          {entry.label}
        </span>
        {description && (
          <span className="text-[9px] text-[var(--text-muted)]">
            {description}
          </span>
        )}
      </div>
      <Switch checked={isOn} onChange={handleToggle} />
    </div>
  );
}

function SelectControl({ entry }: { entry: PresetManifestEntry }) {
  const value = usePreset(entry.key);
  const options = entry.options || [];

  const description = entry.descriptionFn
    ? entry.descriptionFn(value)
    : entry.description;

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const opt = options.find(o => String(o.value) === e.target.value);
    if (opt) presets.set(entry.key, opt.value as never);
  };

  return (
    <div className="flex items-center justify-between rounded-xl p-3 bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
      <div className="flex flex-col gap-0.5">
        <span className="text-[11px] font-semibold text-[var(--text-main)]">
          {entry.label}
        </span>
        {description && (
          <span className="text-[9px] text-[var(--text-muted)]">
            {description}
          </span>
        )}
      </div>
      <select
        value={String(value)}
        onChange={handleChange}
        className="text-[10px] bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-md px-2 py-1 text-[var(--text-main)]"
      >
        {options.map(opt => (
          <option key={String(opt.value)} value={String(opt.value)}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function SliderControl({ entry }: { entry: PresetManifestEntry }) {
  const value = usePreset(entry.key) as number;
  const { min = 0, max = 100, step = 1 } = entry.range || {};

  const description = entry.descriptionFn
    ? entry.descriptionFn(value)
    : entry.description;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    presets.set(entry.key, parseFloat(e.target.value) as never);
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-xl p-3 bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-[var(--text-main)]">
          {entry.label}
        </span>
        <span className="text-[10px] font-mono text-[var(--text-muted)] tabular-nums">
          {value}
        </span>
      </div>
      {description && (
        <span className="text-[9px] text-[var(--text-muted)]">
          {description}
        </span>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={handleChange}
        className="w-full h-1 accent-indigo-500"
      />
    </div>
  );
}

// ─── Control Router ───────────────────────────────────────────────────────────

function PresetControl({ entry }: { entry: PresetManifestEntry }) {
  switch (entry.control) {
    case 'switch':
      return <SwitchControl entry={entry} />;
    case 'select':
      return <SelectControl entry={entry} />;
    case 'slider':
    case 'number':
      return <SliderControl entry={entry} />;
    default:
      return null;
  }
}

// ─── PreferencesPanel ───────────────────────────────────────────────────────

/**
 * PreferencesPanel: Dynamically renders all user-adjustable presets from PRESET_MANIFEST.
 *
 * Contributed to the SETTINGS_CONFIG_PANEL slot (order: 10 → first tab).
 * Groups and controls are auto-generated — adding a new preset only requires
 * editing PRESET_MANIFEST in `core/helpers/preferences/whitelist.ts`.
 */
export function PreferencesPanel() {
  const groups = getGroupedManifest();

  return (
    <div className="flex flex-col gap-4">
      {groups.map(group => (
        <div key={group.name} className="flex flex-col gap-3">
          {/* Group Heading */}
          <h5 className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest flex items-center gap-1.5 pl-1">
            {group.icon && React.createElement(group.icon, { size: 11 })}
            {group.name}
          </h5>

          {/* Controls */}
          {group.entries.map(entry => (
            <PresetControl key={entry.key} entry={entry} />
          ))}
        </div>
      ))}

      <p className="px-1 text-[8px] text-[var(--text-muted)] font-bold leading-relaxed uppercase tracking-tight italic opacity-60">
        Changes take effect immediately and persist across sessions.
      </p>
    </div>
  );
}
