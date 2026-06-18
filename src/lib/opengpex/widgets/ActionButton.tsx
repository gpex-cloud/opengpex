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
import Tooltip, { TooltipPosition, TooltipAlign } from './Tooltip';

interface ActionButtonProps {
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
  label?: string;
  tooltip?: string;
  tooltipPosition?: TooltipPosition;
  tooltipAlign?: TooltipAlign;
  size?: 'sm' | 'md';
  variant?: 'solid' | 'glass';
  className?: string; // Additional classes for the outer wrapper
}

export default function ActionButton({ 
  onClick, 
  disabled, 
  loading, 
  icon, 
  label, 
  tooltip,
  tooltipPosition = 'top',
  tooltipAlign = 'center',
  size = 'md',
  variant = 'solid',
  className = "" 
}: ActionButtonProps) {
  const isGlass = variant === 'glass';

  const buttonContent = (
    <button 
      onClick={onClick} 
      onMouseUp={e => e.currentTarget.blur()}
      onTouchEnd={e => e.currentTarget.blur()}
      disabled={disabled || loading} 
      className={`relative group overflow-hidden rounded-full transition-all cursor-pointer focus:outline-none active:scale-[0.98] disabled:opacity-30 disabled:cursor-not-allowed disabled:grayscale
        ${isGlass ? 'p-0 shadow-none' : 'p-[1px]'}
        ${className}
      `}
    >
      {/* 1. Backdrop / Border Effect */}
      {isGlass ? (
        <div className="absolute inset-0 bg-transparent backdrop-blur-xl ring-1 ring-white/10 dark:ring-white/5 group-hover:ring-indigo-500/30 group-hover:bg-indigo-500/10 transition-all duration-300 rounded-full" />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-r from-indigo-600/80 to-violet-600/80 transition-opacity group-hover:opacity-100 opacity-80" />
      )}
      
      {/* 2. Hover Glow (Only for Glass) */}
      {isGlass && (
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 shadow-[0_0_20px_rgba(99,102,241,0.25)] rounded-full pointer-events-none" />
      )}
      
      {/* 3. Inner Content Box */}
      <div className={`relative rounded-full h-full w-full flex items-center justify-center gap-2 transition-all duration-300
        ${isGlass 
          ? (label ? (size === 'sm' ? 'py-1 px-3' : 'py-1.5 px-4') : (size === 'sm' ? 'p-1.5' : 'p-2.5')) 
          : 'bg-white dark:bg-zinc-950 group-hover:bg-zinc-100/10 dark:group-hover:bg-zinc-900/10 ' + (label ? (size === 'sm' ? 'py-1 px-3' : 'py-1.5 px-4') : (size === 'sm' ? 'p-1.5' : 'p-2'))}
      `}>
        {loading ? (
          <div className="w-4 h-4 border-2 border-indigo-400 border-t-transparent animate-spin rounded-full"></div>
        ) : (
          <>
            {icon && (
              <div className={`transition-all duration-300 drop-shadow-sm
                ${isGlass 
                  ? 'text-zinc-500 dark:text-zinc-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 group-hover:scale-110' 
                  : 'text-indigo-400 group-hover:text-white'}
              `}>
                {icon}
              </div>
            )}
            {label && (
              <span className={`text-[10px] font-black uppercase tracking-[0.18em] whitespace-nowrap transition-all duration-300
                ${isGlass 
                  ? 'text-zinc-600 dark:text-zinc-400 group-hover:text-zinc-900 dark:group-hover:text-zinc-100' 
                  : 'text-zinc-900 dark:text-zinc-100 group-hover:text-white'}
              `}>
                {label}
              </span>
            )}
          </>
        )}
      </div>
    </button>
  );

  if (tooltip) {
    return <Tooltip content={tooltip} position={tooltipPosition} align={tooltipAlign} containerClassName={className}>{buttonContent}</Tooltip>;
  }

  return <div className={className}>{buttonContent}</div>;
}
