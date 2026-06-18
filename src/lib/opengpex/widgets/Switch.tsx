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

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  activeColor?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Switch Component: A reusable toggle switch with support for custom active colors
 * and high-contrast light mode visibility.
 */
const Switch: React.FC<SwitchProps> = ({
  checked,
  onChange,
  activeColor = 'bg-indigo-500',
  disabled = false,
  className = '',
}) => {
  return (
    <div
      role="switch"
      aria-checked={checked}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange(!checked);
      }}
      className={`
        relative w-8 h-4 rounded-full transition-all duration-300 ease-in-out cursor-pointer
        ${checked ? activeColor : 'bg-[var(--border-subtle)]'}
        ${disabled ? 'opacity-50 cursor-not-allowed' : 'active:scale-95'}
        ${className}
      `}
    >
      <div
        className={`
          absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all duration-300 ease-in-out
          ${checked ? 'left-[18.2px]' : 'left-[2px]'}
        `}
      />
    </div>
  );
};

export default Switch;
