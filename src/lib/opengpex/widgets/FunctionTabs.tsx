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
import Tooltip, { TooltipAlign } from './Tooltip';

interface Option<T> {
  label: string;
  value: T;
  icon?: React.ReactNode;
  tooltip?: string;
  tooltipAlign?: TooltipAlign;
  /** Disables this tab only (e.g. the current provider cannot do that task). */
  disabled?: boolean;
}

/**
 * Accent applied to the ACTIVE tab only. The default is the neutral raised pill;
 * 'green' / 'amber' carry the export panel's source-match semantics (green = the
 * selection equals the document's own value, amber = it deviates from it) so a
 * segment control can speak the same colour language as the gamut dropdown.
 */
export type FunctionTabsActiveTone = 'default' | 'green' | 'amber';

const ACTIVE_TONE_CLASSES: Record<FunctionTabsActiveTone, string> = {
  default:
    'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm dark:shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)]',
  green:
    'bg-emerald-50 text-emerald-700 border border-emerald-200/70 shadow-sm dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/25',
  amber:
    'bg-amber-50 text-amber-700 border border-amber-200/70 shadow-sm dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/25',
};

interface FunctionTabsProps<T> {
  options: Option<T>[];
  value: T;
  onChange: (val: T) => void;
  disabled?: boolean;
  className?: string; // Additional wrapper classes
  /** Size variant: 'sm' for compact drawers, 'md' (default) for standard use */
  size?: 'sm' | 'md';
  /** Colour accent of the active tab; see FunctionTabsActiveTone. */
  activeTone?: FunctionTabsActiveTone;
}

export default function FunctionTabs<T extends string>({
  options,
  value,
  onChange,
  disabled,
  className = '',
  size = 'md',
  activeTone = 'default',
}: FunctionTabsProps<T>) {
  const isSm = size === 'sm';

  // Size-dependent classes
  const containerRadius = isSm ? 'rounded-lg' : 'rounded-xl';
  const buttonPadding = isSm ? 'py-1' : 'py-2';
  const buttonRadius = isSm ? 'rounded-md' : 'rounded-lg';
  const fontSize = isSm ? 'text-[9px] font-black uppercase tracking-wider' : 'text-[10px] font-bold';
  const gap = isSm ? 'gap-1' : 'gap-2';

  return (
    <div className={`flex p-0.5 bg-zinc-100/80 dark:bg-black/20 ${containerRadius} border border-zinc-200 dark:border-white/5 ${className} shadow-inner`}>
      {options.map((opt) => {
        const isActive = opt.value === value;
        const isDisabled = disabled || opt.disabled;
        const button = (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            disabled={isDisabled}
            className={`
              w-full flex items-center justify-center ${gap} ${buttonPadding} ${buttonRadius} 
              ${fontSize} transition-all outline-none 
              disabled:opacity-50 disabled:cursor-not-allowed
              ${isActive 
                ? (['crop'].includes(opt.value as string) 
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20 active:scale-[0.98]' 
                    : ACTIVE_TONE_CLASSES[activeTone])
                : 'text-zinc-500 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
              }
            `}
          >
            {opt.icon}
            {opt.label}
          </button>
        );

        if (opt.tooltip) {
          return (
            <Tooltip 
              key={opt.value} 
              content={opt.tooltip} 
              align={opt.tooltipAlign || 'center'}
              display="block" 
              containerClassName="flex-1"
            >
              {button}
            </Tooltip>
          );
        }
        return <div key={opt.value} className="flex-1">{button}</div>;
      })}
    </div>
  );
}
