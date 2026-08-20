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

/**
 * FancyTextArea — Themed textarea widget with action buttons and collapsible support.
 *
 * ─── Usage Examples ────────────────────────────────────────────────────────────
 *
 * 1. Basic editable textarea (standalone card):
 *    <FancyTextArea value={text} onChange={setText} label="Description" placeholder="Enter text..." />
 *
 * 2. Collapsible prompt with delete button (ComfyBridge style):
 *    <FancyTextArea
 *      value={prompt}
 *      onChange={setPrompt}
 *      label="Positive Prompt"
 *      labelClassName="!text-emerald-500/80"
 *      placeholder="Describe what you want..."
 *      height="h-48"
 *      actions={{ collapsible: true, delete: true }}
 *      defaultCollapsed={false}
 *    />
 *
 * 3. Readonly with copy button, slim mode (embedded inside another panel):
 *    <FancyTextArea
 *      value={metadata}
 *      readonly
 *      label="Prompt"
 *      labelClassName="!text-emerald-500/80"
 *      actions={{ copy: true, collapsible: true }}
 *      height="h-[80px]"
 *      slim
 *      defaultCollapsed={true}
 *      className="border-0 rounded-none bg-transparent"
 *    />
 *
 * ─── Props Summary ─────────────────────────────────────────────────────────────
 *
 * | Prop             | Description                                              |
 * |------------------|----------------------------------------------------------|
 * | value            | Textarea content                                         |
 * | onChange         | Change handler (omit for display-only)                   |
 * | readonly         | Disable editing                                          |
 * | disabled         | Disable + dim                                            |
 * | label            | Header label text                                        |
 * | labelClassName   | Override label color (e.g. "!text-rose-500/80")           |
 * | height           | Tailwind height class (default: "h-48")                  |
 * | placeholder      | Placeholder text                                         |
 * | slim             | Remove internal padding (for embedded use)               |
 * | defaultCollapsed | Initial collapsed state (requires actions.collapsible)   |
 * | className        | Additional classes on outer container                    |
 * | actions.copy     | Show copy-to-clipboard button                            |
 * | actions.delete   | Show clear/delete button                                 |
 * | actions.collapsible | Enable collapse/expand toggle                         |
 */

'use client';

import React, { useState, useCallback } from 'react';
import { Copy, Check, Trash, ChevronDown, ChevronRight } from 'lucide-react';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface FancyTextAreaActions {
  /** Show a copy-to-clipboard button. Default: false */
  copy?: boolean;
  /** Show a clear/delete button. Default: false */
  delete?: boolean;
  /** Allow collapsing/expanding the textarea. Default: false */
  collapsible?: boolean;
}

export interface FancyTextAreaProps {
  /** Current value */
  value: string;
  /** Change handler (omit for readonly without editing) */
  onChange?: (value: string) => void;
  /** Placeholder text */
  placeholder?: string;
  /** Whether the textarea is readonly */
  readonly?: boolean;
  /** Whether the textarea is disabled */
  disabled?: boolean;
  /** Action buttons to show in the top-right corner */
  actions?: FancyTextAreaActions;
  /** Height class (Tailwind). Default: 'h-48' */
  height?: string;
  /** Optional label displayed above the textarea */
  label?: string;
  /** Additional className for the label element */
  labelClassName?: string;
  /** Slim mode: removes internal padding for embedding inside already-padded containers. Default: false */
  slim?: boolean;
  /** Whether to start collapsed (only applies when actions.collapsible is true). Default: false */
  defaultCollapsed?: boolean;
  /** Additional className for the outer container */
  className?: string;
}

// ─── Component ─────────────────────────────────────────────────────────────────

/**
 * FancyTextArea — A styled textarea widget with optional action buttons.
 *
 * Features:
 * - Theme-aware scrollbar (custom-scrollbar class)
 * - Optional readonly mode
 * - Configurable top-right action buttons (copy, delete)
 * - Consistent styling with the editor design system
 */
export default function FancyTextArea({
  value,
  onChange,
  placeholder,
  readonly = false,
  disabled = false,
  actions = {},
  height = 'h-48',
  label,
  labelClassName = '',
  slim = false,
  defaultCollapsed = false,
  className = '',
}: FancyTextAreaProps) {
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const isCollapsible = actions.collapsible ?? false;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [value]);

  const handleDelete = useCallback(() => {
    onChange?.('');
  }, [onChange]);

  const showActions = actions.copy || actions.delete;
  const hasContent = value.length > 0;
  const preview = value.length > 60 ? value.slice(0, 60) + '…' : value;

  return (
    <div className={`flex flex-col bg-[var(--bg-stage)] rounded-xl border border-[var(--border-subtle)] focus-within:border-emerald-500/50 transition-colors ${className}`}>
      {/* Header: chevron (if collapsible) + label + preview (if collapsed) + action buttons */}
      {(label || showActions || isCollapsible) && (
        <div
          className={`flex items-center justify-between ${collapsed && !slim ? 'pb-2' : 'pb-0'} ${slim ? 'pt-0' : 'px-2.5 pt-2'} ${isCollapsible ? 'cursor-pointer select-none' : ''}`}
          onClick={isCollapsible ? () => setCollapsed(!collapsed) : undefined}
        >
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            {isCollapsible && (
              collapsed
                ? <ChevronRight size={10} className="text-[var(--text-muted)] shrink-0" />
                : <ChevronDown size={10} className="text-[var(--text-muted)] shrink-0" />
            )}
            {label && (
              <span className={`text-[8px] font-black uppercase tracking-tight text-[var(--text-muted)] ${labelClassName}`}>
                {label}
              </span>
            )}
            {isCollapsible && collapsed && hasContent && (
              <span className="text-[9px] text-[var(--text-muted)] truncate flex-1 ml-1 opacity-60">
                {preview}
              </span>
            )}
          </div>
          {(showActions && !collapsed) && (
            <div className="flex items-center gap-1 ml-auto" onClick={(e) => e.stopPropagation()}>
              {actions.copy && hasContent && (
                <button
                  type="button"
                  onClick={handleCopy}
                  className="p-0.5 rounded transition-colors focus:outline-none"
                  title="Copy to clipboard"
                >
                  {copied ? (
                    <Check size={10} className="text-emerald-500" />
                  ) : (
                    <Copy size={10} className="text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors" />
                  )}
                </button>
              )}
              {actions.delete && hasContent && !readonly && (
                <button
                  type="button"
                  onClick={handleDelete}
                  className="p-0.5 rounded transition-colors focus:outline-none"
                  title="Clear"
                >
                  <Trash size={10} className="text-[var(--text-muted)] hover:text-rose-500 transition-colors" />
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Textarea (hidden when collapsed) */}
      {!collapsed && (
        <div className={slim ? 'pt-[5px] pb-0' : 'px-2 pb-2 pt-[5px]'}>
          <textarea
            value={value}
            onChange={readonly || disabled ? undefined : (e) => onChange?.(e.target.value)}
            readOnly={readonly}
            disabled={disabled}
            placeholder={placeholder}
            className={`w-full ${height} bg-transparent border-none text-[11px] text-[var(--text-main)] resize-none focus:outline-none placeholder:text-[var(--text-muted)] leading-relaxed ${slim ? '' : 'px-1'} custom-scrollbar ${readonly ? 'cursor-default' : ''} ${disabled ? 'opacity-50' : ''}`}
          />
        </div>
      )}
    </div>
  );
}
