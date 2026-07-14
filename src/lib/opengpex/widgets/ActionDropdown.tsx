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

import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import EditorPortal from './Portal';

export interface ActionOption {
  label?: string;
  value?: string;
  description?: string;
  icon?: React.ReactNode;
  variant?: 'default' | 'danger' | 'success';
  divider?: boolean;
  /** Show a checkmark on the right side of the option. */
  checked?: boolean;
}

interface ActionDropdownProps {
  trigger: React.ReactNode | ((isOpen: boolean) => React.ReactNode);
  options: ActionOption[];
  onSelect: (value: string) => void;
  className?: string;
  align?: 'left' | 'right';
  disabled?: boolean;
  /** Number of columns for the option grid layout. Default is 1 (standard vertical list). */
  cols?: number;
  /** Direction to open the menu. 'down' (default) opens below trigger, 'up' opens above trigger. */
  direction?: 'down' | 'up';
}

export default function ActionDropdown({
  trigger,
  options,
  onSelect,
  className = '',
  align = 'left',
  disabled = false,
  cols = 1,
  direction = 'down'
}: ActionDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, bottom: 0, left: 0, width: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const isOutsideTrigger = containerRef.current && !containerRef.current.contains(target);
      const isOutsideMenu = menuRef.current && !menuRef.current.contains(target);
      
      if (isOutsideTrigger && isOutsideMenu) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('click', handleClickOutside);
    }
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [isOpen]);

  const updateCoords = () => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setCoords({
        top: rect.bottom,
        bottom: rect.top,
        left: rect.left,
        width: rect.width
      });
    }
  };

  const handleTriggerClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;
    updateCoords();
    setIsOpen(!isOpen);
  };

  return (
    <div ref={containerRef} className={`relative inline-block ${className}`}>
      {/* Trigger Area */}
      <div 
        onClick={handleTriggerClick}
        className={`cursor-pointer select-none transition-all ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
      >
        {typeof trigger === 'function' ? trigger(isOpen) : trigger}
      </div>

      {/* Menu Area (Rendered via Portal) */}
      <AnimatePresence>
        {isOpen && (
          <EditorPortal>
            <motion.div
              ref={menuRef}
              initial={{ opacity: 0, y: direction === 'up' ? -8 : 8, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1, x: align === 'right' ? '-100%' : 0 }}
              exit={{ opacity: 0, y: direction === 'up' ? -8 : 8, scale: 0.95 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300, x: { duration: 0 } }}
              style={{
                position: 'fixed',
                ...(direction === 'up'
                  ? { bottom: window.innerHeight - coords.bottom + 8 }
                  : { top: coords.top + 8 }),
                left: align === 'right' ? coords.left + coords.width : coords.left,
                zIndex: 10000,
                pointerEvents: 'auto'
              }}
              className={`
                min-w-[130px] 
                bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl
                border border-zinc-200 dark:border-white/10 
                rounded-xl shadow-[0_20px_50px_rgba(0,0,0,0.3)] p-1 overflow-hidden
              `}
            >
              <div
                className={cols > 1 ? 'grid gap-0.5' : 'flex flex-col gap-0.5'}
                style={cols > 1 ? { gridTemplateColumns: `repeat(${cols}, 1fr)` } : undefined}
              >
                {options.map((opt, idx) => {
                  if (opt.divider) {
                    return (
                      <div
                        key={`div-${idx}`}
                        className="my-0.5 border-t border-zinc-200 dark:border-white/10"
                        style={cols > 1 ? { gridColumn: `span ${cols}` } : undefined}
                      />
                    );
                  }
                  return (
                    <button
                      key={opt.value}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (opt.value) onSelect(opt.value);
                        setIsOpen(false);
                      }}
                      className={`
                        flex items-center justify-between gap-3 w-full px-2 py-1.5 rounded-lg
                        text-[9px] font-black uppercase tracking-tight text-left
                        transition-all active:scale-[0.98] cursor-pointer
                        ${opt.variant === 'danger' 
                          ? 'text-rose-500 hover:bg-rose-500/10' 
                          : opt.variant === 'success'
                            ? 'text-emerald-500 hover:bg-emerald-500/10'
                            : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/5 hover:text-zinc-900 dark:hover:text-zinc-100'
                        }
                      `}
                    >
                      <div className="flex items-center gap-2">
                        {opt.icon && <span className="opacity-70 flex items-center justify-center scale-90">{opt.icon}</span>}
                        <span>{opt.label}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {opt.description && (
                          <span className="text-[7.5px] font-bold opacity-40 tabular-nums">
                            {opt.description}
                          </span>
                        )}
                        {opt.checked && (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-500 shrink-0">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          </EditorPortal>
        )}
      </AnimatePresence>
    </div>
  );
}
