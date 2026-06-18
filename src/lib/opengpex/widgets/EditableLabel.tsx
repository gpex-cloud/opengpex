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

import React, { useState, useEffect, useRef } from 'react';

interface EditableLabelProps {
  value: string;
  prefix?: string;
  suffix?: string;
  onCommit: (v: string) => void;
  className?: string;
  type?: 'text' | 'number';
  doubleClick?: boolean;
}

export default function EditableLabel({ 
  value, 
  prefix = '', 
  suffix = '', 
  onCommit, 
  className = '',
  doubleClick = false
}: EditableLabelProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [tempValue, setTempValue] = useState(value);
  const [prevIsEditing, setPrevIsEditing] = useState(isEditing);
  const [prevValue, setPrevValue] = useState(value);

  if (isEditing !== prevIsEditing || value !== prevValue) {
    setPrevIsEditing(isEditing);
    setPrevValue(value);
    if (isEditing) {
      setTempValue(value);
    }
  }
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 20);
      return () => clearTimeout(timer);
    }
  }, [isEditing]);

  const handleCommit = () => {
    setIsEditing(false);
    onCommit(tempValue);
  };

  const handleCancel = () => {
    setIsEditing(false);
    setTempValue(value);
  };

  if (isEditing) {
    return (
      <div className="flex items-center gap-1 group-hover:bg-transparent">
        {prefix && <span className="opacity-40 text-[9px] font-black uppercase tracking-widest">{prefix}</span>}
        <input
          ref={inputRef}
          type="text"
          className="bg-zinc-800 text-white outline-none ring-1 ring-indigo-500/50 rounded-md px-1 py-0.5 min-w-[40px] max-w-[90px] text-center font-bold tabular-nums text-[10px] animate-in zoom-in-95 duration-200"
          value={tempValue}
          onChange={e => setTempValue(e.target.value)}
          onBlur={handleCommit}
          onPointerDown={e => e.stopPropagation()}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === 'Enter') handleCommit();
            if (e.key === 'Escape') handleCancel();
          }}
        />
        {suffix && <span className="opacity-40 text-[9px] font-black uppercase tracking-widest">{suffix}</span>}
      </div>
    );
  }

  const triggerProps = doubleClick ? {
    onDoubleClick: (e: React.MouseEvent) => { e.stopPropagation(); setIsEditing(true); }
  } : {
    onClick: (e: React.MouseEvent) => { e.stopPropagation(); setIsEditing(true); }
  };

  return (
    <div 
      className={`${doubleClick ? 'cursor-pointer' : 'cursor-text'} hover:bg-white/5 transition-all px-1.5 py-0.5 rounded-md pointer-events-auto flex items-center gap-1 group/editable ${className}`}
      {...triggerProps}
    >
      {prefix && <span className="opacity-40 text-[9px] font-black uppercase tracking-widest group-hover/editable:text-indigo-400 transition-colors">{prefix}</span>}
      <span className="font-bold">{value}</span>
      {suffix && <span className="opacity-40 text-[9px] font-black uppercase tracking-widest group-hover/editable:text-indigo-400 transition-colors">{suffix}</span>}
    </div>
  );
}
