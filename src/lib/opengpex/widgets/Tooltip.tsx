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

import React, { ReactNode, useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { EDITOR_Z_INDEX } from '@opengpex/editor/core/helpers/config';

export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';
export type TooltipAlign = 'start' | 'center' | 'end';

interface TooltipProps {
  content: ReactNode;
  position?: TooltipPosition;
  children: ReactNode;
  className?: string;
  showOnHover?: boolean;
  alwaysShow?: boolean;
  display?: 'inline' | 'block' | 'inline-flex';
  containerClassName?: string;
  align?: TooltipAlign;
  uppercase?: boolean;
  contentClassName?: string;
}

export default function Tooltip({
  content,
  position = 'top',
  children,
  className = '',
  showOnHover = true,
  alwaysShow = false,
  display = 'inline',
  containerClassName = '',
  align = 'center',
  uppercase = true,
  contentClassName = ''
}: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  const updateCoords = () => {
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setTooltipPos({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height
      });
    }
  };

  const handleMouseEnter = () => {
    // Environment-awareness: do not display if inside a container marked to suppress Tooltip (like menu mode)
    if (anchorRef.current?.closest('.suppress-tooltips')) return;
    
    updateCoords();
    setIsVisible(true);
  };


  const handleMouseLeave = () => {
    setIsVisible(false);
  };

  // automatically calculate position when alwaysShow active (no need to wait for mouseEnter)
  useEffect(() => {
    if (alwaysShow) {
      updateCoords();
    }
  }, [alwaysShow]);

  // Listen to scroll or zoom to ensure Tooltip follows
  useEffect(() => {
    if (isVisible || alwaysShow) {
      window.addEventListener('scroll', updateCoords, true);
      window.addEventListener('resize', updateCoords);
      return () => {
        window.removeEventListener('scroll', updateCoords, true);
        window.removeEventListener('resize', updateCoords);
      };
    }
  }, [isVisible, alwaysShow]);

  // Calculate absolute position style for Tooltip
  const getTooltipStyle = () => {
    if (!tooltipPos) return {};
    
    let top = tooltipPos.top;
    let left = tooltipPos.left;
    let transform = '';

    const offset = 8; // spacing

    switch (position) {
      case 'top':
        top -= offset;
        transform = 'translateY(-100%)';
        if (align === 'center') left += tooltipPos.width / 2;
        if (align === 'end') left += tooltipPos.width;
        if (align === 'center') transform += ' translateX(-50%)';
        if (align === 'end') transform += ' translateX(-100%)';
        break;
      case 'bottom':
        top += tooltipPos.height + offset;
        if (align === 'center') left += tooltipPos.width / 2;
        if (align === 'end') left += tooltipPos.width;
        if (align === 'center') transform = 'translateX(-50%)';
        if (align === 'end') transform = 'translateX(-100%)';
        break;
      case 'left':
        left -= offset;
        transform = 'translateX(-100%)';
        if (align === 'center') top += tooltipPos.height / 2;
        if (align === 'end') top += tooltipPos.height;
        if (align === 'center') transform += ' translateY(-50%)';
        if (align === 'end') transform += ' translateY(-100%)';
        break;
      case 'right':
        left += tooltipPos.width + offset;
        if (align === 'center') top += tooltipPos.height / 2;
        if (align === 'end') top += tooltipPos.height;
        if (align === 'center') transform = 'translateY(-50%)';
        if (align === 'end') transform = 'translateY(-100%)';
        break;
    }

    return {
      position: 'fixed' as const,
      top,
      left,
      transform,
      zIndex: EDITOR_Z_INDEX.UI.TOOLTIP,
      pointerEvents: 'none' as const
    };
  };

  // Arrow style configuration (maintain original logic)
  const arrowStyles: Record<TooltipPosition, Record<TooltipAlign, string>> = {
    top: {
      start: 'top-full left-4 -translate-x-1/2 border-t-white dark:border-t-zinc-900 border-l-transparent border-r-transparent border-b-0',
      center: 'top-full left-1/2 -translate-x-1/2 border-t-white dark:border-t-zinc-900 border-l-transparent border-r-transparent border-b-0',
      end: 'top-full right-4 translate-x-1/2 border-t-white dark:border-t-zinc-900 border-l-transparent border-r-transparent border-b-0',
    },
    bottom: {
      start: 'bottom-full left-4 -translate-x-1/2 border-b-white dark:border-b-zinc-900 border-l-transparent border-r-transparent border-t-0',
      center: 'bottom-full left-1/2 -translate-x-1/2 border-b-white dark:border-b-zinc-900 border-l-transparent border-r-transparent border-t-0',
      end: 'bottom-full right-4 translate-x-1/2 border-b-white dark:border-b-zinc-900 border-l-transparent border-r-transparent border-t-0',
    },
    left: {
      start: 'left-full top-4 -translate-y-1/2 border-l-white dark:border-l-zinc-900 border-t-transparent border-b-transparent border-r-0',
      center: 'left-full top-1/2 -translate-y-1/2 border-l-white dark:border-l-zinc-900 border-t-transparent border-b-transparent border-r-0',
      end: 'left-full bottom-4 translate-y-1/2 border-l-white dark:border-l-zinc-900 border-t-transparent border-b-transparent border-r-0',
    },
    right: {
      start: 'right-full top-4 -translate-y-1/2 border-r-white dark:border-r-zinc-900 border-t-transparent border-b-transparent border-l-0',
      center: 'right-full top-1/2 -translate-y-1/2 border-r-white dark:border-r-zinc-900 border-t-transparent border-b-transparent border-l-0',
      end: 'right-full bottom-4 translate-y-1/2 border-r-white dark:border-r-zinc-900 border-t-transparent border-b-transparent border-l-0',
    },
  };


  const containerClass = `${display === 'block' ? 'w-full' : display === 'inline-flex' ? 'inline-flex items-center' : 'inline-block'} ${containerClassName}`;

  return (
    <div 
      ref={anchorRef}
      className={containerClass}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {(alwaysShow || (isVisible && showOnHover)) && typeof document !== 'undefined' && createPortal(
        <div
          style={getTooltipStyle()}
          className={`whitespace-nowrap animate-in fade-in zoom-in-95 duration-200 ${className}`}
        >
          <div className={`bg-white dark:bg-zinc-900 text-zinc-800 dark:text-white text-[10px] rounded-lg py-1.5 px-2.5 shadow-2xl border border-zinc-200 dark:border-white/10 ${uppercase ? 'uppercase font-bold tracking-wider' : 'font-medium tracking-tight whitespace-pre-line leading-relaxed'} ${contentClassName}`}>
            {content}
          </div>
          <div className={`border-4 border-transparent w-0 h-0 absolute ${arrowStyles[position][align]}`}></div>
        </div>,
        document.body
      )}
    </div>
  );
}
