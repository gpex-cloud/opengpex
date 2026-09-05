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

import React, { useState } from 'react';
import { ColorPickerPro } from '@opengpex/editor/widgets/ColorPickerPro';
import Popover from '@opengpex/editor/widgets/Popover';
import Tooltip from '@opengpex/editor/widgets/Tooltip';
import { useMarkerPanel } from '../hooks';

const ROW_LABEL = 'text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-20 shrink-0';
const NUM_INPUT = 'w-8 bg-transparent text-right focus:outline-none outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none';
const RANGE_CLASS = 'flex-1 h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border-t border-[var(--border-subtle)] border-b border-[var(--border-subtle)] shadow-inner';

/**
 * ColorSwatchRow: compact color control — a small swatch + hex label that opens
 * the full ColorPickerPro inside a Popover on click.
 *
 * This replaces the always-open inline picker (which occupied ~140px of vertical
 * space per color). Mirrors the mainstream editor pattern (Figma / Photoshop /
 * this app's own ColorOptions toolbar): the panel stays dense, and the heavy
 * SV-area picker only appears on demand.
 */
const ColorSwatchRow = React.memo(function ColorSwatchRow({
  label,
  color,
  onChange,
}: {
  label: string;
  color: string;
  onChange: (c: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex items-center gap-2 px-1">
      <span className={ROW_LABEL}>{label}</span>
      <Popover
        isOpen={open}
        onClose={() => setOpen(false)}
        position="left"
        align="start"
        content={
          <div className="w-52 p-2.5">
            <ColorPickerPro
              variant="compact"
              color={color}
              onChange={onChange}
            />
          </div>
        }
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 flex-1 px-1.5 py-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-stage)] hover:border-indigo-500/40 transition-colors"
        >
          <span
            className="w-4 h-4 rounded shadow-inner ring-1 ring-black/15 dark:ring-white/20 shrink-0"
            style={{ backgroundColor: color }}
          />
          <span className="text-[10px] font-bold uppercase tabular-nums text-[var(--text-main)] tracking-tight">
            {color}
          </span>
        </button>
      </Popover>
    </div>
  );
});

/**
 * MarkerPanel: annotation marker attributes panel.
 *
 * Rendered inside CraftDrawer, displayed when activeCraft === 'marker'.
 * - Type selector rendered dynamically from MARKER_REGISTRY (adding a marker
 *   kind auto-extends this row, no panel edit needed).
 * - Stroke section (all kinds). Fill / corner-radius sections shown only for
 *   kinds whose definition declares hasFill / hasCornerRadius.
 * - Color controls use the compact ColorSwatchRow (swatch → Popover) so the
 *   panel stays dense instead of stacking two full inline pickers.
 * Bindings are two-way with the selected marker layer (or pending style when
 * none selected) via useMarkerPanel.
 */
export const MarkerPanel = React.memo(function MarkerPanel() {
  const {
    definitions,
    activeMarkerKind,
    activeDef,
    markerData,
    selectKind,
    updateMarkerData,
  } = useMarkerPanel();

  if (!markerData) return null;

  const strokeWidth = markerData.stroke.width;
  const strokeColor = markerData.stroke.color;
  const fillColor = markerData.fill.color;
  const fillOpacityPct = Math.round(markerData.fill.opacity * 100);
  const cornerRadius = markerData.kind === 'rect' ? markerData.cornerRadius : 0;

  return (
    <div className="flex flex-col gap-2">
      {/* ─── Marker type selector (dynamic from registry) ─── */}
      <div className="flex flex-col gap-1.5 p-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          {definitions.map((def) => {
            const isActive = def.kind === activeMarkerKind;
            return (
              <Tooltip key={def.kind} content={def.label} position="top" display="inline-flex">
                <button
                  type="button"
                  aria-label={def.label}
                  onClick={() => selectKind(def.kind)}
                  className={`flex items-center justify-center w-[52px] py-2.5 rounded-lg border transition-colors ${
                    isActive
                      ? 'bg-indigo-500/15 border-indigo-500/40 text-indigo-600 dark:text-indigo-300'
                      : 'bg-[var(--bg-stage)] border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-main)]'
                  }`}
                >
                  {def.icon}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>

      {/* ─── Stroke (all kinds) ─── */}
      <div className="flex flex-col gap-1.5 p-1">
        <ColorSwatchRow
          label="Stroke Color"
          color={strokeColor}
          onChange={(c) => updateMarkerData({ stroke: { ...markerData.stroke, color: c } })}
        />

        <div className="flex items-center gap-1.5 px-1">
          <span className={ROW_LABEL}>Stroke Width</span>
          <input
            type="range"
            min="1"
            max="50"
            step="1"
            value={strokeWidth}
            onChange={(e) => updateMarkerData({ stroke: { ...markerData.stroke, width: Number(e.target.value) } }, true)}
            onMouseUp={(e) => { updateMarkerData({ stroke: { ...markerData.stroke, width: Number((e.target as HTMLInputElement).value) } }); e.currentTarget.blur(); }}
            className={RANGE_CLASS}
          />
          <div className="flex items-center gap-0.5 text-right w-9 justify-end text-indigo-600 dark:text-indigo-400 font-black text-[10px] tabular-nums">
            <input
              type="number"
              min="1"
              max="50"
              value={strokeWidth}
              onChange={(e) => updateMarkerData({ stroke: { ...markerData.stroke, width: Math.max(1, Math.min(50, Number(e.target.value) || 1)) } })}
              className={NUM_INPUT}
            />
            <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">px</span>
          </div>
        </div>
      </div>

      {/* ─── Fill (hasFill kinds only) ─── */}
      {activeDef?.hasFill && (
        <div className="flex flex-col gap-1.5 p-1">
          <ColorSwatchRow
            label="Fill Color"
            color={fillColor}
            onChange={(c) => updateMarkerData({ fill: { ...markerData.fill, color: c } })}
          />

          <div className="flex items-center gap-1.5 px-1">
            <span className={ROW_LABEL}>Fill Opacity</span>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={fillOpacityPct}
              onChange={(e) => updateMarkerData({ fill: { ...markerData.fill, opacity: Number(e.target.value) / 100 } }, true)}
              onMouseUp={(e) => { updateMarkerData({ fill: { ...markerData.fill, opacity: Number((e.target as HTMLInputElement).value) / 100 } }); e.currentTarget.blur(); }}
              className={RANGE_CLASS}
            />
            <div className="flex items-center gap-0.5 text-right w-9 justify-end text-indigo-600 dark:text-indigo-400 font-black text-[10px] tabular-nums">
              <input
                type="number"
                min="0"
                max="100"
                value={fillOpacityPct}
                onChange={(e) => updateMarkerData({ fill: { ...markerData.fill, opacity: Math.max(0, Math.min(100, Number(e.target.value) || 0)) / 100 } })}
                className={NUM_INPUT}
              />
              <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">%</span>
            </div>
          </div>
        </div>
      )}

      {/* ─── Corner radius (hasCornerRadius kinds only) ─── */}
      {activeDef?.hasCornerRadius && markerData.kind === 'rect' && (
        <div className="flex flex-col gap-1.5 p-1">
          <div className="flex items-center gap-1.5 px-1">
            <span className={ROW_LABEL}>Corner Radius</span>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={cornerRadius}
              onChange={(e) => updateMarkerData({ cornerRadius: Number(e.target.value) } as never, true)}
              onMouseUp={(e) => { updateMarkerData({ cornerRadius: Number((e.target as HTMLInputElement).value) } as never); e.currentTarget.blur(); }}
              className={RANGE_CLASS}
            />
            <div className="flex items-center gap-0.5 text-right w-9 justify-end text-indigo-600 dark:text-indigo-400 font-black text-[10px] tabular-nums">
              <input
                type="number"
                min="0"
                max="500"
                value={cornerRadius}
                onChange={(e) => updateMarkerData({ cornerRadius: Math.max(0, Math.min(500, Number(e.target.value) || 0)) } as never)}
                className={NUM_INPUT}
              />
              <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">px</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
