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

import React, { useCallback } from "react";
import { Magnet, Filter, SlidersHorizontal, Power } from "lucide-react";
import Switch from "@opengpex/editor/widgets/Switch";
import { usePluginSelfConfig } from "@opengpex/editor/core/context";
import { SmartGuidesConfig } from "../protocols";

type ExcludableLayerType = 'text' | 'paint' | 'vector' | 'color';

/**
 * SmartGuidesSettings: Settings panel contributed to SETTINGS_CONFIG_PANEL.
 * Allows users to fine-tune which layers participate in smart guide snapping.
 */
export function SmartGuidesSettings() {
  const [config, setConfig] = usePluginSelfConfig<SmartGuidesConfig>();

  const toggle = useCallback((key: keyof SmartGuidesConfig) => {
    setConfig({ [key]: !config[key] } as Partial<SmartGuidesConfig>);
  }, [config, setConfig]);

  const toggleExclude = useCallback((type: ExcludableLayerType) => {
    const current = config.excludeLayerTypes || [];
    const next = current.includes(type)
      ? current.filter(t => t !== type)
      : [...current, type];
    setConfig({ excludeLayerTypes: next });
  }, [config, setConfig]);

  return (
    <div className="flex flex-col gap-4">
      {/* ─── Master Toggle ─── */}
      <div className="flex items-center justify-between rounded-xl p-3 bg-[var(--bg-stage)] border border-amber-500/50">
        <div className="flex items-center gap-2">
          <Power size={14} className={config.enabled ? "text-amber-500" : "text-[var(--text-muted)]"} />
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-bold text-[var(--text-main)]">Smart Guides Toggler</span>
            <span className="text-[9px] text-[var(--text-muted)]">⌘⇧; to toggle</span>
          </div>
        </div>
        <Switch checked={config.enabled} onChange={() => toggle('enabled')} />
      </div>

      {/* ─── Section 1: Snap Targets ─── */}
      <div className="flex flex-col gap-3">
        <h5 className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest flex items-center gap-1.5 pl-1">
          <Magnet size={11} /> Snap To
        </h5>

        <SwitchRow
          label="Canvas edges & center"
          description="Snap to canvas boundaries and midpoint"
          checked={config.snapToCanvas}
          onChange={() => toggle('snapToCanvas')}
        />
        <SwitchRow
          label="Layer birth position"
          description="Snap to layer's original spawn center"
          checked={config.snapToBirth}
          onChange={() => toggle('snapToBirth')}
        />
        <SwitchRow
          label="Other layers"
          description="Snap to edges and centers of sibling layers"
          checked={config.snapToLayers}
          onChange={() => toggle('snapToLayers')}
        />
      </div>

      {/* ─── Section 2: Exclude Layer Types ─── */}
      <div className="flex flex-col gap-3">
        <h5 className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest flex items-center gap-1.5 pl-1">
          <Filter size={11} /> Exclude Layer Types
        </h5>

        <SwitchRow
          label="Text layers"
          description="Don't snap to text layers"
          checked={config.excludeLayerTypes?.includes('text') ?? false}
          onChange={() => toggleExclude('text')}
        />
        <SwitchRow
          label="Paint/Brush layers"
          description="Don't snap to paint layers"
          checked={config.excludeLayerTypes?.includes('paint') ?? false}
          onChange={() => toggleExclude('paint')}
        />
        <SwitchRow
          label="Vector layers"
          description="Don't snap to vector shape layers"
          checked={config.excludeLayerTypes?.includes('vector') ?? false}
          onChange={() => toggleExclude('vector')}
        />
        <SwitchRow
          label="Color fill layers"
          description="Don't snap to solid color layers"
          checked={config.excludeLayerTypes?.includes('color') ?? false}
          onChange={() => toggleExclude('color')}
        />
      </div>

      {/* ─── Section 3: Advanced ─── */}
      <div className="flex flex-col gap-3">
        <h5 className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest flex items-center gap-1.5 pl-1">
          <SlidersHorizontal size={11} /> Advanced
        </h5>

        <SwitchRow
          label="Ignore locked layers"
          description="Locked layers won't attract snapping"
          checked={config.ignoreLockedLayers}
          onChange={() => toggle('ignoreLockedLayers')}
        />
        <SwitchRow
          label="Ignore small fragments"
          description="Skip layers smaller than 20×20 screen px"
          checked={config.ignoreSmallLayers}
          onChange={() => toggle('ignoreSmallLayers')}
        />
      </div>

      <p className="px-1 text-[8px] text-[var(--text-muted)] font-bold leading-relaxed uppercase tracking-tight italic opacity-60">
        ⌘; to open this panel • ⌘⇧; to toggle guides
      </p>
    </div>
  );
}

/** Reusable Switch Row (follows Onboarding settings pattern) */
function SwitchRow({ label, description, checked, onChange }: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-xl p-3 bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
      <div className="flex flex-col gap-0.5">
        <span className="text-[11px] font-semibold text-[var(--text-main)]">{label}</span>
        <span className="text-[9px] text-[var(--text-muted)]">{description}</span>
      </div>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}
