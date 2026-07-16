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

import React, { useRef } from 'react';
import { Minus, Plus } from 'lucide-react';

interface ComfyNumberInputProps {
  value: number;
  onChange: (val: number) => void;
  disabled?: boolean;
  className?: string;
  /** Label displayed to the left of the input */
  label?: string;
  /**
   * Number of decimal places.
   * - 0 (default): integer mode, step = 1
   * - 1: tenths (e.g. cfg: 7.5), step = 0.1
   * - 2: hundredths (e.g. denoise: 0.75), step = 0.01
   * - 3: thousandths, step = 0.001
   *
   * Controls both the +/- step size and display formatting.
   */
  decimals?: number;
}

/**
 * ComfyNumberInput — A number input with +/- increment buttons.
 *
 * Step size is determined by the `decimals` prop:
 * - decimals=0 → step 1 (integer)
 * - decimals=1 → step 0.1 (one decimal place, e.g. cfg)
 * - decimals=2 → step 0.01 (two decimal places, e.g. denoise)
 *
 * Display is auto-formatted to `decimals` fixed places.
 */
export default function ComfyNumberInput({
  value,
  onChange,
  disabled = false,
  className = '',
  label,
  decimals = 0,
}: ComfyNumberInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const step = Math.pow(10, -decimals); // decimals=0→1, decimals=1→0.1, decimals=2→0.01

  const handleDecrement = () => {
    if (disabled) return;
    const newVal = value - step;
    // Round to avoid floating point artifacts
    onChange(parseFloat(newVal.toFixed(decimals)));
  };

  const handleIncrement = () => {
    if (disabled) return;
    const newVal = value + step;
    onChange(parseFloat(newVal.toFixed(decimals)));
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v)) onChange(v);
  };

  // Format display value
  const displayValue = decimals > 0 ? value.toFixed(decimals) : String(value);

  return (
    <div className={`flex items-center gap-0 w-full ${className}`}>
      {label && (
        <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-14 shrink-0 truncate mr-1.5">
          {label}
        </span>
      )}
      <div className="flex items-center flex-1 h-[26px] rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-stage)] overflow-hidden">
        {/* Minus button */}
        <button
          type="button"
          onClick={handleDecrement}
          disabled={disabled}
          className="flex items-center justify-center w-6 h-full text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--border-subtle)] transition-colors shrink-0 disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none"
        >
          <Minus size={10} />
        </button>
        {/* Input */}
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          value={displayValue}
          onChange={handleInputChange}
          onBlur={() => {
            // Re-format on blur
            onChange(parseFloat(value.toFixed(decimals)));
          }}
          disabled={disabled}
          className="flex-1 h-full bg-transparent border-none text-center text-[10px] font-black text-[var(--text-main)] tabular-nums focus:outline-none disabled:opacity-50"
        />
        {/* Plus button */}
        <button
          type="button"
          onClick={handleIncrement}
          disabled={disabled}
          className="flex items-center justify-center w-6 h-full text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--border-subtle)] transition-colors shrink-0 disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none"
        >
          <Plus size={10} />
        </button>
      </div>
    </div>
  );
}
