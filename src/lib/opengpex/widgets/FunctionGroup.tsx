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
}

interface FunctionGroupProps<T> {
  options: Option<T>[];
  value: T;
  onChange: (val: T) => void;
  disabled?: boolean;
  className?: string; // Additional wrapper classes
  /** Size variant: 'sm' for compact drawers, 'md' (default) for standard use */
  size?: 'sm' | 'md';
}

export default function FunctionGroup<T extends string>({
  options,
  value,
  onChange,
  disabled,
  className = '',
  size = 'md',
}: FunctionGroupProps<T>) {
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
        const button = (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            disabled={disabled}
            className={`
              w-full flex items-center justify-center ${gap} ${buttonPadding} ${buttonRadius} 
              ${fontSize} transition-all outline-none 
              disabled:opacity-50 
              ${isActive 
                ? (['crop'].includes(opt.value as string) 
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20 active:scale-[0.98]' 
                    : 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm dark:shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)]')
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
