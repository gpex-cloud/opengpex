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

interface FunctionButtonProps {
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  loading?: boolean;
  children: React.ReactNode;
  title?: React.ReactNode;
  className?: string;
  active?: boolean;
  variant?: 'glass' | 'solid' | 'ghost';
  shape?: 'square' | 'circle';
  tooltipAlign?: TooltipAlign;
  tooltipPosition?: TooltipPosition;
}

export default function FunctionButton({
  onClick,
  disabled,
  loading = false,
  children,
  title,
  className = '',
  active = false,
  variant = 'glass',
  shape = 'square',
  tooltipAlign = 'center',
  tooltipPosition = 'top',
  ...props
}: FunctionButtonProps & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  
  // 1. Style variant logic
  const getVariantStyles = () => {
    switch (variant) {
      case 'glass':
        return active 
          ? 'bg-indigo-600/20 border-indigo-500/30 text-indigo-500 dark:text-indigo-400 shadow-[0_0_20px_rgba(99,102,241,0.1)]'
          : 'bg-transparent border-transparent text-zinc-500 hover:bg-zinc-800/5 dark:hover:bg-white/5 hover:text-zinc-900 dark:hover:text-zinc-100 transition-all duration-200';
      case 'solid':
        return active
          ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 border-transparent'
          : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-transparent hover:bg-zinc-200 dark:hover:bg-zinc-700';
      case 'ghost':
        return active
          ? 'text-indigo-500 dark:text-indigo-400 border-zinc-200 dark:border-white/5'
          : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-white border-transparent hover:bg-zinc-800/5 dark:hover:bg-white/5';
      default:
        return '';
    }
  };

  /**
   * Smart title parsing logic:
   * Supports auto-splitting of "Name (Shortcut/Status)" format.
   */
  const titleStr = typeof title === 'string' ? title : '';
  const match = titleStr.match(/^(.*?)\s*\((.*?)\)$/);
  const label = match ? match[1] : titleStr;
  const shortcut = match ? match[2] : undefined;

  const buttonContent = (
    <button
      onClick={onClick}
      onMouseUp={e => e.currentTarget.blur()}
      onTouchEnd={e => e.currentTarget.blur()}
      disabled={disabled || loading}
      data-label={label || undefined}
      data-shortcut={shortcut || undefined}
      data-active={active || undefined}
      onKeyDown={(e) => {
        if (e.key === ' ') {
          e.preventDefault();
        }
      }}

      {...props}


      className={`
        relative flex items-center justify-center gap-1.5 transition-all duration-300
        ${shape === 'circle' ? 'rounded-full' : 'rounded-xl'}
        ${!className.includes('w-') ? 'w-9' : ''}
        ${!className.includes('h-') ? 'h-9' : ''}
        shrink-0 border font-bold uppercase cursor-pointer focus:outline-none 
        disabled:opacity-20 disabled:cursor-not-allowed active:scale-[0.96]
        ${getVariantStyles()}
        ${className}
      `}
    >
      {loading && (
        <svg className="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
      )}
      {children}
    </button>
  );

  if (title) {
    return (
      <Tooltip 
        content={title} 
        align={tooltipAlign} 
        position={tooltipPosition} 
        display="inline-flex" 
        containerClassName="flex justify-center w-full"
      >
        {buttonContent}
      </Tooltip>
    );
  }

  return buttonContent;
}
