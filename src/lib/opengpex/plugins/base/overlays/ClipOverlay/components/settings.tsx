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
import Switch from '@opengpex/editor/widgets/Switch';
import { Scissors } from 'lucide-react';
import type { ClipOverlayConfig } from '../protocols';

/**
 * ClipOverlaySettings: Settings panel contribution for Selection / Clip Overlay.
 * Allows users to toggle marching ants animation.
 */
export function ClipOverlaySettings() {
  const [config, updateConfig] = usePluginSelfConfig<ClipOverlayConfig>();

  return (
    <div className="flex flex-col gap-3">
      <h5 className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest pl-1">
        Selection Display
      </h5>

      {/* Marching Ants Animation Toggle */}
      <button
        onClick={() => updateConfig({ marchingAntsAnimated: !config.marchingAntsAnimated })}
        className="flex items-center justify-between w-full p-2.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] group"
      >
        <div className="flex items-center gap-3">
          <div
            className={`w-7 h-7 rounded-lg flex-shrink-0 flex items-center justify-center transition-colors ${config.marchingAntsAnimated ? 'bg-indigo-500/10 text-indigo-500' : 'bg-[var(--bg-stage)] text-[var(--text-muted)]'}`}
          >
            <Scissors size={13} />
          </div>
          <div className="flex flex-col items-start leading-tight text-left">
            <span className="text-[10px] font-black text-[var(--text-main)] uppercase tracking-tight">
              Animated Selection
            </span>
            <span className="text-[8px] text-[var(--text-muted)] font-bold uppercase">
              Marching ants · Higher Power Consumption
            </span>
          </div>
        </div>
        <Switch
          checked={config.marchingAntsAnimated ?? false}
          onChange={(v) => updateConfig({ marchingAntsAnimated: v })}
          activeColor="bg-indigo-500"
        />
      </button>
    </div>
  );
}
