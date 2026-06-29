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
import { ChevronDown } from 'lucide-react';
import EditorPortal from './Portal';

interface ComboInputProps<T extends string | number> {
  label?: string;
  value: T;
  onChange: (val: T) => void;
  disabled?: boolean;
  options?: T[];
  className?: string;
  type?: 'number' | 'text';
  readOnly?: boolean;
  /** Optional inline style applied to the input element (for font preview etc.) */
  inputStyle?: React.CSSProperties;
  /** Whether to render dropdown via Portal (default: true). Set to false to keep dropdown in-container. */
  byPortal?: boolean;
}

/**
 * A combined input and dropdown component.
 * Ported to new architecture.
 */
export default function ComboInput<T extends string | number>({
  label,
  value,
  onChange,
  disabled,
  options = [],
  className = "",
  type = 'text',
  readOnly = false,
  inputStyle,
  byPortal = true,
}: ComboInputProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0, width: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node) &&
        (!dropdownRef.current || !dropdownRef.current.contains(e.target as Node))
      ) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      if (byPortal && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setCoords({
          top: rect.bottom + window.scrollY,
          left: rect.left + window.scrollX,
          width: rect.width
        });
      }
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, byPortal]);

  const handleInputClick = () => {
    if (readOnly) setIsOpen(!isOpen);
  };

  // ─── Dropdown content (shared between portal and inline modes) ────────
  const dropdownContent = (
    <div className="max-h-[300px] overflow-y-auto py-1.5">
      {options.map((opt) => (
        <button
          key={opt}
          onClick={(e) => {
            e.stopPropagation();
            onChange(opt);
            setIsOpen(false);
          }}
          className={`
            w-full px-4 py-2 text-left text-[10px] font-bold tabular-nums transition-colors cursor-pointer
            ${value === opt 
              ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/20' 
              : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/5 hover:text-zinc-900 dark:hover:text-zinc-100'
            }
          `}
        >
          {opt}
        </button>
      ))}
    </div>
  );

  return (
    <div ref={containerRef} className={`relative flex items-center bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg px-2.5 py-1.5 gap-1.5 transition-all focus-within:border-indigo-500/50 focus-within:ring-1 focus-within:ring-indigo-500/20 ${disabled ? 'opacity-50 pointer-events-none' : ''} ${className}`}>
      {label && (
        <span className="text-[9px] font-black text-zinc-400 dark:text-zinc-600 shrink-0 select-none uppercase tracking-tighter">
          {label}
        </span>
      )}
      
      <input 
        type="text" 
        value={value || ''}
        readOnly={readOnly}
        onClick={handleInputClick}
        inputMode={type === 'number' ? 'numeric' : 'text'}
        onChange={(e) => {
          if (readOnly) return;
          if (type === 'number') {
            const val = parseInt(e.target.value.replace(/\D/g, '')) || 0;
            onChange(val as T);
          } else {
            onChange(e.target.value as T);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setIsOpen(false);
          if (e.key === 'Enter') {
            setIsOpen(false);
            e.currentTarget.blur();
          }
        }}
        className={`bg-transparent ${label ? 'text-right' : 'text-center pl-1'} text-[10px] w-full outline-none font-bold tabular-nums text-zinc-900 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-700 ${readOnly ? 'cursor-pointer' : ''}`}
        style={inputStyle}
        placeholder="-"
      />

      {options && options.length > 0 && (
        <button 
          onClick={() => setIsOpen(!isOpen)}
          className="pl-1.5 border-l border-zinc-200 dark:border-zinc-800 text-zinc-400 dark:text-zinc-600 hover:text-indigo-500 transition-colors cursor-pointer"
        >
          <ChevronDown size={12} className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
        </button>
      )}

      {isOpen && options && options.length > 0 && (
        byPortal ? (
          <EditorPortal>
            <div 
              ref={dropdownRef}
              data-drawer-bar="portal"
              style={{
                position: 'fixed',
                top: coords.top + 6,
                left: coords.left,
                width: coords.width,
                zIndex: 1100
              }}
              className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-top-1 duration-200 ring-1 ring-black/5 pointer-events-auto"
            >
              {dropdownContent}
            </div>
          </EditorPortal>
        ) : (
          <div 
            className="absolute top-full left-0 right-0 mt-1.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-top-1 duration-200 ring-1 ring-black/5 z-50"
          >
            {dropdownContent}
          </div>
        )
      )}
    </div>
  );
}
