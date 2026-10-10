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
import { ChevronDown } from 'lucide-react';
import ActionDropdown, { type ActionOption } from './ActionDropdown';
import Tooltip from './Tooltip';

/**
 * SplitButton — a compound control with a primary action button on the left
 * and a dropdown chevron on the right, rendered as a single cohesive pill.
 *
 * Visual anatomy:
 *
 *   ┌──────────┬───┐
 *   │  ↺ icon  │ ▾ │   ← single pill, no visible seam at rest
 *   └──────────┴───┘
 *        ↑        ↑
 *   primary click  dropdown trigger
 *
 * Design rules:
 * - Matches ActionButton glass/sm dimensions (h-6, rounded-full)
 * - Hover on left half highlights the primary zone only
 * - Hover on right half highlights the chevron zone only
 * - A subtle 1px separator appears on hover between the two zones
 * - Active/pressed state uses scale(0.98) like ActionButton
 */

export interface SplitButtonProps {
  /** Icon for the primary (left) action. In memorized mode, falls back to active option's icon if omitted. */
  icon?: React.ReactNode;
  /** Tooltip for the primary action. In memorized mode, falls back to active option's label if omitted. */
  tooltip?: string;
  /** Primary click handler (left part). */
  onClick: (e: React.MouseEvent<HTMLButtonElement>, value?: string) => void;
  /** Dropdown menu options (right chevron). */
  dropdownOptions: ActionOption[];
  /** Handler when a dropdown option is selected. Optional if onChange is used. */
  onDropdownSelect?: (value: string) => void;
  /** Callback when selected value changes (for memorized mode). */
  onChange?: (value: string) => void;
  /** Controlled value for memorized mode. */
  value?: string;
  /** Uncontrolled default value for memorized mode. */
  defaultValue?: string;
  /** Explicit flag to enable memorization even if value/defaultValue are omitted. */
  memorize?: boolean;
  /** Compact style: removes the separator line, tightens padding/gap matching ClipOptions chevron style. */
  compact?: boolean;
  /** Borderless style (e.g. when embedding in an outer container like FancyGroup). */
  borderless?: boolean;
  /** Active / selected state styling. */
  active?: boolean;
  /** Dropdown alignment. Default 'right'. */
  dropdownAlign?: 'left' | 'right';
  /** Border radius shape. 'rounded' = rounded-md (matches ActionGroup), 'pill' = rounded-full. Default 'rounded'. */
  shape?: 'rounded' | 'pill';
  /** Disabled state for the entire control. */
  disabled?: boolean;
  /** Additional className for the outer container. */
  className?: string;
  /** Position for the tooltip. Default 'bottom'. */
  tooltipPosition?: 'top' | 'bottom' | 'left' | 'right';
}

export default function SplitButton({
  icon,
  tooltip,
  onClick,
  dropdownOptions,
  onDropdownSelect,
  onChange,
  value,
  defaultValue,
  memorize,
  compact = false,
  borderless = false,
  active = false,
  tooltipPosition = 'bottom',
  dropdownAlign = 'right',
  shape = 'rounded',
  disabled = false,
  className = '',
}: SplitButtonProps) {
  const isPill = shape === 'pill';
  const outerRadius = isPill ? 'rounded-full' : 'rounded-md';
  const leftRadius = isPill ? 'rounded-l-full' : 'rounded-l-md';
  const rightRadius = isPill ? 'rounded-r-full' : 'rounded-r-md';
  // h-5 (20px) matches ActionGroup; h-6 (24px) for pill/standalone use
  const height = isPill ? 'h-6' : 'h-5';

  const isMemorized = Boolean(memorize || value !== undefined || defaultValue !== undefined);
  const [internalValue, setInternalValue] = React.useState<string | undefined>(defaultValue);
  const currentValue = value !== undefined ? value : internalValue;

  const activeOption = isMemorized
    ? dropdownOptions.find((opt) => opt.value === currentValue)
    : undefined;

  const displayIcon = (isMemorized && activeOption?.icon) ? activeOption.icon : icon;
  const displayTooltip = (isMemorized && (activeOption?.label || activeOption?.description))
    ? (activeOption.label || activeOption.description)
    : tooltip;

  const handleSelect = (selectedVal: string) => {
    if (isMemorized && value === undefined) {
      setInternalValue(selectedVal);
    }
    onChange?.(selectedVal);
    onDropdownSelect?.(selectedVal);
  };

  const resolvedOptions = React.useMemo(() => {
    if (!isMemorized) return dropdownOptions;
    return dropdownOptions.map((opt) => ({
      ...opt,
      checked: opt.checked !== undefined ? opt.checked : (opt.value === currentValue),
    }));
  }, [dropdownOptions, isMemorized, currentValue]);

  const primaryButton = (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e, currentValue);
      }}
      className={`
        relative flex items-center justify-center
        ${borderless ? 'h-full' : height} ${compact ? 'px-1.5' : 'w-6'} ${leftRadius}
        ${active ? 'text-amber-500 bg-[var(--bg-stage)]' : 'text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-zinc-100 dark:hover:bg-white/8'}
        active:scale-[0.96]
        transition-all duration-150
        disabled:opacity-30 disabled:cursor-not-allowed
        cursor-pointer select-none outline-none focus:outline-none focus-visible:outline-none
      `}
      aria-label={displayTooltip}
    >
      {displayIcon}
    </button>
  );

  const chevronTrigger = (
    <button
      type="button"
      disabled={disabled}
      className={`
        relative flex items-center justify-center
        ${borderless ? 'h-full' : height} ${compact ? 'px-1 -ml-0.5' : 'w-3.5'} ${rightRadius}
        text-[var(--text-muted)] hover:text-[var(--text-main)]
        ${active ? 'text-amber-500/80 hover:text-amber-500 hover:bg-zinc-100 dark:hover:bg-white/8' : 'hover:bg-zinc-100 dark:hover:bg-white/8'}
        ${compact ? 'opacity-60 hover:opacity-100' : ''}
        active:scale-[0.96]
        transition-all duration-150
        disabled:opacity-30 disabled:cursor-not-allowed
        cursor-pointer select-none outline-none focus:outline-none focus-visible:outline-none
      `}
      aria-label="More options"
    >
      <ChevronDown size={8} strokeWidth={2.5} />
    </button>
  );

  // Tooltip anchors to the primary button only — hovering the dropdown chevron
  // must not surface the primary action's tooltip.
  const primaryWithTooltip = displayTooltip ? (
    <Tooltip content={displayTooltip} position={tooltipPosition} display="inline-flex">
      {primaryButton}
    </Tooltip>
  ) : (
    primaryButton
  );

  const content = (
    <div
      className={`
        group/split inline-flex items-center select-none outline-none
        ${outerRadius} ${borderless ? '' : 'overflow-hidden border border-[var(--border-subtle)] hover:border-indigo-500/30'}
        transition-all duration-200
        ${disabled ? 'opacity-50 pointer-events-none' : ''}
        ${className}
      `}
    >
      {primaryWithTooltip}
      {/* Separator — visible on group hover, hidden in compact mode */}
      {!compact && (
        <div className="w-px h-3 bg-zinc-300/0 dark:bg-white/0 group-hover/split:bg-zinc-300 dark:group-hover/split:bg-white/15 transition-colors duration-200" />
      )}
      <ActionDropdown
        trigger={chevronTrigger}
        options={resolvedOptions}
        onSelect={handleSelect}
        align={dropdownAlign}
        disabled={disabled}
      />
    </div>
  );

  return content;
}
