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

import { usePluginSelfConfig } from '@opengpex/editor/core/context';
import { Grid } from 'lucide-react';
import * as P from './protocols';
import type { GridLineStyle } from './protocols';

const LINE_STYLE_OPTIONS: ReadonlyArray<{
  value: GridLineStyle;
  label: string;
  hint: string;
}> = [
  {
    value: 'dual',
    label: 'Dual-tone',
    hint: 'Dark + light pair · visible on any image · tuned for Retina / high-dpi screens',
  },
  {
    value: 'dark',
    label: 'Dark',
    hint: 'Single dark line · best on light images',
  },
  {
    value: 'light',
    label: 'Light',
    hint: 'Single light line · best on dark images',
  },
];

/**
 * PixelGridSettings: Settings panel contribution for the pixel grid overlay.
 *
 * Three mutually-exclusive line styles (radio semantics): the default
 * dual-tone pair plus the two single-tone hairlines. The preference is never
 * locked or rewritten by the display: below the dual-tone DPR floor the
 * RENDER path degrades 'dual' to the single light line on its own (see
 * lineStyle.ts), so dragging the window between displays needs no setting
 * change — the panel just annotates the degraded state.
 */
export function PixelGridSettings() {
  const [config, updateConfig] = usePluginSelfConfig<P.PixelGridConfig>();
  const style: GridLineStyle = config.lineStyle ?? P.DEFAULT_LINE_STYLE;
  const selectedOption =
    LINE_STYLE_OPTIONS.find((opt) => opt.value === style) ?? LINE_STYLE_OPTIONS[0];
  const dualFits =
    (typeof window !== 'undefined' ? window.devicePixelRatio : 2) >= P.DUAL_TONE_MIN_DPR;

  return (
    <div className="flex flex-col gap-3">
      <h5 className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest pl-1">
        Pixel Grid
      </h5>

      <div className="flex flex-col gap-2 p-2.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 flex-shrink-0">
            <div className="w-7 h-7 rounded-lg flex-shrink-0 flex items-center justify-center bg-[var(--bg-stage)] text-[var(--text-muted)]">
              <Grid size={13} />
            </div>
            <div className="flex flex-col items-start leading-tight text-left">
              <span className="text-[10px] font-black text-[var(--text-main)] uppercase tracking-tight">
                Line Style
              </span>
              <span className="text-[8px] text-[var(--text-muted)] font-bold uppercase">
                {selectedOption.hint}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1" role="radiogroup" aria-label="Pixel grid line style">
            {LINE_STYLE_OPTIONS.map((opt) => {
              const selected = style === opt.value;
              return (
                <button
                  key={opt.value}
                  role="radio"
                  aria-checked={selected}
                  title={opt.hint}
                  onClick={() => updateConfig({ lineStyle: opt.value })}
                  className={`px-2 py-1 rounded-md border text-[9px] font-black uppercase tracking-tight transition-colors ${
                    selected
                      ? 'bg-indigo-500/10 border-indigo-500/40 text-indigo-500'
                      : 'bg-[var(--bg-stage)] border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-main)]'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {style === 'dual' && !dualFits && (
          <span className="text-[8px] text-[var(--text-muted)] font-bold uppercase leading-snug">
            Display too coarse for dual-tone — rendering a single light hairline
          </span>
        )}
      </div>
    </div>
  );
}
