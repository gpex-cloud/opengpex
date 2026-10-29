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
  variant?: 'default' | 'danger' | 'success' | 'warning';
  divider?: boolean;
  /** Show a checkmark on the right side of the option. */
  checked?: boolean;
  /** Sub-menu options — renders a nested fly-out on hover. */
  children?: ActionOption[];
}

/** Floor used to predict submenu overflow before it is measured. */
const SUBMENU_MIN_WIDTH = 120;

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
  /** Max number of visible items before scrolling. Default is unlimited. */
  maxVisibleItems?: number;
  /** Whether the menu width should match the trigger width. Default is false. */
  matchTriggerWidth?: boolean;
}

export default function ActionDropdown({
  trigger,
  options,
  onSelect,
  className = '',
  align = 'left',
  disabled = false,
  cols = 1,
  direction = 'down',
  maxVisibleItems,
  matchTriggerWidth = false,
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
    <div ref={containerRef} className={`relative inline-block select-none outline-none ${className}`}>
      {/* Trigger Area — suppress mousedown default so clickable trigger
          content (buttons, tabIndex spans) never takes focus on click;
          otherwise a subsequent Space/Enter re-fires the trigger instead of
          reaching the canvas shortcuts */}
      <div
        onMouseDown={(e) => e.preventDefault()}
        onClick={handleTriggerClick}
        className={`cursor-pointer select-none outline-none transition-all ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
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
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: direction === 'up' ? -8 : 8, scale: 0.95 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              style={{
                position: 'fixed',
                ...(direction === 'up'
                  ? { bottom: window.innerHeight - coords.bottom + 8 }
                  : { top: coords.top + 8 }),
                // Right-aligned menus anchor via `right` instead of
                // `left` + translateX(-100%): a fixed element's shrink-to-fit
                // width is measured from `left` to the viewport edge, so
                // anchoring at a trigger near the right screen edge (right-
                // docked drawer) would squeeze the menu down to its
                // min-width and wrap every label. With `right`, the fit
                // space extends leftward and the menu keeps its natural
                // width regardless of dock side.
                ...(align === 'right'
                  ? { right: Math.max(8, window.innerWidth - (coords.left + coords.width)) }
                  : { left: coords.left }),
                ...(matchTriggerWidth ? { width: coords.width } : {}),
                zIndex: 10000,
                pointerEvents: 'auto'
              }}
              className={`
                min-w-[130px] 
                bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl
                border border-zinc-200 dark:border-white/10 
                rounded-xl shadow-[0_20px_50px_rgba(0,0,0,0.3)] p-1
              `}
              data-sampler-chrome=""
            >
              <div
                className={`${cols > 1 ? 'grid gap-0.5' : 'flex flex-col gap-0.5'}${maxVisibleItems ? ' custom-scrollbar' : ''}`}
                style={{
                  ...(cols > 1 ? { gridTemplateColumns: `repeat(${cols}, 1fr)` } : {}),
                  ...(maxVisibleItems
                    ? { maxHeight: `${maxVisibleItems * 32}px`, overflowY: 'auto' }
                    : {}),
                }}
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
                  // ── Sub-menu option ──
                  if (opt.children && opt.children.length > 0) {
                    return (
                      <SubMenuOption
                        key={opt.value ?? `sub-${idx}`}
                        option={opt}
                        onSelect={(val) => { onSelect(val); setIsOpen(false); }}
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
                          : opt.variant === 'warning'
                            ? 'text-amber-500 hover:bg-amber-500/10'
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

// ─── SubMenuOption (internal) ─────────────────────────────────────────────────

function SubMenuOption({ option, onSelect }: { option: ActionOption; onSelect: (val: string) => void }) {
  const [open, setOpen] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Submenus extend rightward by default; when the parent menu sits close
  // to the viewport's right edge (right-docked drawer) the fly-out would
  // clip offscreen, so it flips to extend leftward instead.
  const [placement, setPlacement] = useState<'right' | 'left'>('right');

  const handleEnter = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      setPlacement(
        rect.right + 8 + SUBMENU_MIN_WIDTH > window.innerWidth ? 'left' : 'right',
      );
    }
    setOpen(true);
  };
  const handleLeave = () => {
    timerRef.current = setTimeout(() => setOpen(false), 120);
  };

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <button
        className="flex items-center justify-between gap-3 w-full px-2 py-1.5 rounded-lg
          text-[9px] font-black uppercase tracking-tight text-left
          transition-all cursor-pointer
          text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/5 hover:text-zinc-900 dark:hover:text-zinc-100"
      >
        <div className="flex items-center gap-2">
          {option.icon && <span className="opacity-70 flex items-center justify-center scale-90">{option.icon}</span>}
          <span>{option.label}</span>
        </div>
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="opacity-40 shrink-0">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -4 }}
            transition={{ duration: 0.1 }}
            className={`absolute top-0 min-w-[120px]
              ${placement === 'right' ? 'left-full ml-1' : 'right-full mr-1'}
              bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl
              border border-zinc-200 dark:border-white/10
              rounded-xl shadow-[0_20px_50px_rgba(0,0,0,0.3)] p-1
              flex flex-col gap-0.5 z-[10001]`}
          >
            {option.children!.map(child => (
              <button
                key={child.value}
                onClick={(e) => {
                  e.stopPropagation();
                  if (child.value) onSelect(child.value);
                }}
                className={`
                  flex items-center gap-2 w-full px-2 py-1.5 rounded-lg
                  text-[9px] font-black uppercase tracking-tight text-left
                  transition-all active:scale-[0.98] cursor-pointer
                  ${child.variant === 'danger'
                    ? 'text-rose-500 hover:bg-rose-500/10'
                    : child.variant === 'warning'
                      ? 'text-amber-500 hover:bg-amber-500/10'
                      : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/5 hover:text-zinc-900 dark:hover:text-zinc-100'
                  }
                `}
              >
                {child.icon && <span className="opacity-70 flex items-center justify-center scale-90">{child.icon}</span>}
                <span className="truncate">{child.label}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

