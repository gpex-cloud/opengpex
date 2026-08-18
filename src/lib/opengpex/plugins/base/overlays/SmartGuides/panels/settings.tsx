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
import { presets } from "@opengpex/editor/core/helpers/preferences";
import { usePreset } from "@opengpex/editor/core/helpers/preferences/usePreset";

type ExcludableLayerType = 'text' | 'paint' | 'vector' | 'color';

/**
 * SmartGuidesSettings: Settings panel contributed to SETTINGS_CONFIG_PANEL.
 * Allows users to fine-tune which layers participate in smart guide snapping.
 *
 * All settings (including the master toggle) use PresetsFactory (core infrastructure).
 */
export function SmartGuidesSettings() {
  // Master toggle via PresetsFactory (synchronous, no race condition)
  const snapEnabled = usePreset('SNAP_ENABLED');

  // Snap settings via PresetsFactory
  const snapToCanvas = usePreset('SNAP_TO_CANVAS');
  const snapToBirth = usePreset('SNAP_TO_BIRTH');
  const snapToLayers = usePreset('SNAP_TO_LAYERS');
  const excludeLayerTypes = usePreset('SNAP_EXCLUDE_LAYER_TYPES');
  const ignoreLockedLayers = usePreset('SNAP_IGNORE_LOCKED_LAYERS');
  const ignoreSmallLayers = usePreset('SNAP_IGNORE_SMALL_LAYERS');
  const edgeSnapScope = usePreset('SNAP_EDGE_SCOPE');

  const toggleExclude = useCallback((type: ExcludableLayerType) => {
    const current = excludeLayerTypes || [];
    const next = current.includes(type)
      ? current.filter(t => t !== type)
      : [...current, type];
    presets.set('SNAP_EXCLUDE_LAYER_TYPES', next);
  }, [excludeLayerTypes]);

  return (
    <div className="flex flex-col gap-4">
      {/* ─── Master Toggle ─── */}
      <div className="flex items-center justify-between rounded-xl p-3 bg-[var(--bg-stage)] border border-amber-500/50">
        <div className="flex items-center gap-2">
          <Power size={14} className={snapEnabled ? "text-amber-500" : "text-[var(--text-muted)]"} />
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-bold text-[var(--text-main)]">Smart Guides Toggler</span>
            <span className="text-[9px] text-[var(--text-muted)]">⌘⇧; to toggle</span>
          </div>
        </div>
        <Switch checked={snapEnabled} onChange={() => presets.set('SNAP_ENABLED', !snapEnabled)} />
      </div>

      {/* ─── Section 1: Snap Targets ─── */}
      <div className="flex flex-col gap-3">
        <h5 className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest flex items-center gap-1.5 pl-1">
          <Magnet size={11} /> Snap To
        </h5>

        <SwitchRow
          label="Canvas edges & center"
          description="Snap to canvas boundaries and midpoint"
          checked={snapToCanvas}
          onChange={() => presets.set('SNAP_TO_CANVAS', !snapToCanvas)}
        />
        <SwitchRow
          label="Layer birth position"
          description="Snap to layer's original spawn center"
          checked={snapToBirth}
          onChange={() => presets.set('SNAP_TO_BIRTH', !snapToBirth)}
        />
        <SwitchRow
          label="Other layers"
          description="Snap to edges and centers of sibling layers"
          checked={snapToLayers}
          onChange={() => presets.set('SNAP_TO_LAYERS', !snapToLayers)}
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
          checked={excludeLayerTypes?.includes('text') ?? false}
          onChange={() => toggleExclude('text')}
        />
        <SwitchRow
          label="Paint/Brush layers"
          description="Don't snap to paint layers"
          checked={excludeLayerTypes?.includes('paint') ?? false}
          onChange={() => toggleExclude('paint')}
        />
        <SwitchRow
          label="Vector layers"
          description="Don't snap to vector shape layers"
          checked={excludeLayerTypes?.includes('vector') ?? false}
          onChange={() => toggleExclude('vector')}
        />
        <SwitchRow
          label="Color fill layers"
          description="Don't snap to solid color layers"
          checked={excludeLayerTypes?.includes('color') ?? false}
          onChange={() => toggleExclude('color')}
        />
      </div>

      {/* ─── Section 3: Edge Snap ─── */}
      <div className="flex flex-col gap-3">
        <h5 className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest flex items-center gap-1.5 pl-1">
          <SlidersHorizontal size={11} /> Edge Snap (Resize)
        </h5>

        <SwitchRow
          label="Snap edges for all selections"
          description="When off, edge snap only works for Re-Canvas resize"
          checked={edgeSnapScope === 'all'}
          onChange={() => presets.set('SNAP_EDGE_SCOPE', edgeSnapScope === 'all' ? 'recanvas' : 'all')}
        />
      </div>

      {/* ─── Section 4: Advanced ─── */}
      <div className="flex flex-col gap-3">
        <h5 className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest flex items-center gap-1.5 pl-1">
          <SlidersHorizontal size={11} /> Advanced
        </h5>

        <SwitchRow
          label="Ignore locked layers"
          description="Locked layers won't attract snapping"
          checked={ignoreLockedLayers}
          onChange={() => presets.set('SNAP_IGNORE_LOCKED_LAYERS', !ignoreLockedLayers)}
        />
        <SwitchRow
          label="Ignore small fragments"
          description="Skip layers smaller than 20×20 screen px"
          checked={ignoreSmallLayers}
          onChange={() => presets.set('SNAP_IGNORE_SMALL_LAYERS', !ignoreSmallLayers)}
        />
      </div>

      {/* ─── Reset to Defaults ─── */}
      <button
        type="button"
        onClick={() => {
          presets.reset('SNAP_ENABLED');
          presets.reset('SNAP_TO_CANVAS');
          presets.reset('SNAP_TO_BIRTH');
          presets.reset('SNAP_TO_LAYERS');
          presets.reset('SNAP_EXCLUDE_LAYER_TYPES');
          presets.reset('SNAP_IGNORE_LOCKED_LAYERS');
          presets.reset('SNAP_IGNORE_SMALL_LAYERS');
          presets.reset('SNAP_SMALL_LAYER_THRESHOLD');
          presets.reset('SNAP_MAX_TARGETS');
          presets.reset('SNAP_EDGE_SCOPE');
        }}
        className="w-full rounded-xl p-2.5 text-[10px] font-bold text-[var(--text-muted)] bg-[var(--bg-stage)] border border-[var(--border-subtle)] hover:border-amber-500/50 hover:text-amber-500 transition-colors uppercase tracking-wider"
      >
        Reset Snap Settings to Defaults
      </button>

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
