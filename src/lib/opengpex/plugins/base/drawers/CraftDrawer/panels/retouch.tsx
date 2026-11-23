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

import React from "react";
import FunctionTabs from "@opengpex/editor/widgets/FunctionTabs";
import { useEditorServices, useEditorState } from "@opengpex/editor/core/context";
import { useRetouchPanel } from "../hooks";
import { MOSAIC_SIZE_PRESETS } from "../protocols";
import { RETOUCH_MODE_ICONS } from "../icon";
import { clearCloneSourceFor } from "@opengpex/editor/plugins/base/overlays/RetouchOverlay/stroke/clone/cloneSource";
import { runFullFrameDustRemoval } from "@opengpex/editor/plugins/base/overlays/RetouchOverlay/stroke/dust/dustRemoval";

// ─── RetouchPanel ───────────────────────────────────────────────────────────────

/**
 * RetouchPanel: Retouch tool attributes panel (mosaic/heal/blur/sharpen/clone)
 *
 * Rendered inside CraftDrawer, displayed when activeCraft='mosaic'.
 * Top: variant switch (five retouch modes, icon+text, ordered by practical
 * usage frequency — heal is the everyday spot fixer, clone covers larger
 * structural repeats, mosaic is the privacy pixelator, blur/sharpen are the
 * finishing pair). Below: the mode-specific controls — radius+strength
 * sliders for blur/sharpen, the Alt+Click pick-source hint for clone, and
 * the shared XS-XL preset tabs (block size for mosaic, stamp diameter for
 * every other mode).
 */

const MODE_OPTIONS = ([
  { value: 'heal', label: 'Heal' },
  { value: 'clone', label: 'Clone' },
  { value: 'mosaic', label: 'Mosaic' },
  { value: 'blur', label: 'Blur' },
  { value: 'sharpen', label: 'Sharp' },
] as const).map(({ value, label }) => {
  const Icon = RETOUCH_MODE_ICONS[value];
  // Stacked layout (glyph above, caption below) — the same vertical idiom as
  // the size-preset tabs under this switch.
  return {
    value,
    label: '',
    icon: (
      <span className="flex flex-col items-center gap-1 py-0.5">
        <Icon size={18} />
        <span className="text-[9px] font-black uppercase tracking-wider">{label}</span>
      </span>
    ),
  };
});

const PRESET_OPTIONS = (['XS', 'S', 'M', 'L', 'XL'] as const).map((key) => {
  const data = MOSAIC_SIZE_PRESETS[key];
  return {
    value: key,
    label: '',
    icon: (
      <span className="flex flex-col items-center gap-1 py-0.5">
        <span className="text-[12px] font-black">{key}</span>
        {/* Caption = stamp diameter (what the Diameter row edits). The mosaic
            block size is communicated by the section label instead. */}
        <span className="text-[9px] font-medium opacity-60">{data.brushDiameter}px</span>
      </span>
    ),
    // No tooltip — the caption already states the diameter.
  };
});

/** Radius/strength slider row (the brush panel's slider idiom, single-line). */
function SliderRow({ label, value, min, max, unit = 'px', onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 px-1">
      <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-16 shrink-0">
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step="1"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onMouseUp={(e) => e.currentTarget.blur()}
        onTouchEnd={(e) => e.currentTarget.blur()}
        className="flex-1 h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border-t border-b border-[var(--border-subtle)] shadow-inner"
      />
      <div className="flex items-center gap-0.5 text-right w-12 justify-end text-indigo-600 dark:text-indigo-400 font-black text-[10px] tabular-nums">
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(e) => {
            const val = Number(e.target.value);
            if (Number.isFinite(val)) onChange(val);
          }}
          className="w-8 bg-transparent text-right focus:outline-none outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">{unit}</span>
      </div>
    </div>
  );
}

export const RetouchPanel = React.memo(function RetouchPanel() {
  const {
    sizePreset, setSizePreset, toolMode, setToolMode,
    blurRadius, setBlurRadius, blurStrength, setBlurStrength,
    hardness, setHardness, dustSensitivity, setDustSensitivity,
    stampDiameter, blockSize, isCustomDiameter, setStampDiameter,
  } = useRetouchPanel();

  const isConv = toolMode === 'blur' || toolMode === 'sharpen';
  const isClone = toolMode === 'clone';
  const isHeal = toolMode === 'heal';
  const { activeFrame } = useEditorState();
  const { actions, pixels, assets, layers } = useEditorServices();
  const [dustRunning, setDustRunning] = React.useState(false);

  const runDustRemoval = React.useCallback(async () => {
    if (!activeFrame || dustRunning) return;
    setDustRunning(true);
    try {
      const result = await runFullFrameDustRemoval(
        { layers, pixels, assets, actions, activeFrame },
        dustSensitivity,
      );
      if (result.healed > 0) return;
      // Nothing changed — pick the message from the skip reason so a blank
      // layer, a wrong layer kind, and a clean scan read differently.
      const messages: Record<NonNullable<typeof result.skipReason>, string> = {
        'no-pixel-layer': 'Remove Dust needs a pixel (image) layer selected.',
        'empty-layer': 'The selected layer has no pixels to scan.',
        'transformed-layer': 'Remove Dust skips rotated/flipped layers — heal those spots manually.',
        'no-specks': 'No dust specks detected at this sensitivity.',
      };
      const reason = result.skipReason ?? 'no-specks';
      actions.notifyHUD(messages[reason], reason === 'no-specks' ? 'info' : 'error');
    } finally {
      setDustRunning(false);
    }
  }, [activeFrame, dustRunning, dustSensitivity, layers, pixels, assets, actions]);

  return (
    <div className="flex flex-col gap-2 p-1">
      {/* ── Top: Variant switch (five retouch modes) ── */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight px-1">
          Tools (Tab to cycle)
        </span>
        <FunctionTabs
          options={MODE_OPTIONS as unknown as { value: string; label: string }[]}
          value={toolMode}
          onChange={(v) => setToolMode(v as typeof toolMode)}
          size="sm"
        />
      </div>

      {/* ── Middle: Divider ── */}
      <div className="border-t border-[var(--border-subtle)] dark:border-white/10 my-1" />

      {/* ── Clone: constant pick-source hint row (explicit-arm affordance) ── */}
      {isClone && (
        <>
          <div className="flex items-center gap-1.5 px-1">
            <span className="text-[9px] font-black uppercase tracking-tight text-amber-600 dark:text-amber-400 shrink-0">
              Pick Source
            </span>
            <span className="text-[9px] font-medium text-[var(--text-muted)]">
              Alt+Click canvas to set the copy origin
            </span>
            <button
              title="Clear this frame's clone source"
              onClick={() => { if (activeFrame) clearCloneSourceFor(activeFrame.id); }}
              className="ml-auto shrink-0 w-4 h-4 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-stage)] transition-all outline-none"
            >
              ✕
            </button>
          </div>
          <SliderRow label="Hardness" value={hardness} min={0} max={100} unit="%" onChange={setHardness} />
        </>
      )}

      {/* ── Blur/Sharpen: shared radius + strength sliders (one blur pass serves both) ── */}
      {isConv && (
        <>
          <SliderRow label="Radius" value={blurRadius} min={1} max={64} onChange={setBlurRadius} />
          <SliderRow label="Strength" value={blurStrength} min={0} max={100} unit="%" onChange={setBlurStrength} />
        </>
      )}

      {/* ── Heal: full-frame Remove Dust (the automated heal variant).
          Result lands on the heal layer family — undo/erase like a manual stroke.
          No divider here: the Tools section already draws one, and heal mode
          would stack a second line right under it. ── */}
      {isHeal && (
        <>
          <button
            onClick={runDustRemoval}
            disabled={dustRunning || !activeFrame}
            title="Detect dust specks across the entire active layer and heal them automatically (manual dabbing stays available)"
            className="mt-1.5 w-full h-7 rounded-md text-[10px] font-black uppercase tracking-wider text-[var(--text-main)] bg-[var(--bg-stage)] border border-[var(--border-subtle)] hover:bg-[var(--bg-stage)]/70 hover:border-[var(--text-muted)] transition-all outline-none disabled:opacity-50 disabled:cursor-wait"
          >
            {dustRunning ? 'Removing…' : 'Remove All Dust'}
          </button>
          <SliderRow label="Sensitivity" value={dustSensitivity} min={0} max={100} unit="%" onChange={setDustSensitivity} />
        </>
      )}

      {/* ── Lower: Size preset (block size for mosaic, stamp diameter for the rest);
          mt-1.5 keeps this section visually separated from the mode rows above ── */}
      <div className="flex flex-col gap-1.5 mt-1.5">
        <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight px-1">
          {toolMode === 'mosaic' ? `Block Size (${blockSize}px)` : 'Stamp Size'}
        </span>
        <FunctionTabs
          options={PRESET_OPTIONS}
          value={isCustomDiameter ? ('' as typeof sizePreset) : sizePreset}
          onChange={setSizePreset}
          size="sm"
        />
        {/* Free-entry diameter: typing here switches to a custom stamp size
            (no preset tab highlighted); clicking a preset tab reverts. */}
        <SliderRow label="Diameter" value={stampDiameter} min={2} max={400} onChange={setStampDiameter} />
      </div>
    </div>
  );
});
