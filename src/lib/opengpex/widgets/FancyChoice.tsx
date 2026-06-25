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

import React, { useEffect, useRef, useState } from 'react';
import { Motion } from '@opengpex/editor/core/motion';
import { X, type LucideIcon } from 'lucide-react';

export interface ChoiceOption {
  id: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
  /** Gradient classes for the icon container, e.g. "from-indigo-500 to-purple-600" */
  iconGradient?: string;
  /** If true, uses a solid gradient button style (primary action) */
  primary?: boolean;
}

interface FancyChoiceProps {
  isVisible: boolean;
  title: string;
  options: ChoiceOption[];
  onSelect: (id: string) => void;
  onCancel: () => void;
}

/**
 * FancyChoice: Multi-option choice dialog with card-style buttons.
 * Inspired by the landing page action cards (Open Image / Drag & Drop).
 * Features:
 * - Card-style option buttons with icon, label, and description
 * - Close (X) button in top-right corner to cancel
 * - Escape key to dismiss
 * - Smooth enter/exit animations
 */
export default function FancyChoice({
  isVisible,
  title,
  options,
  onSelect,
  onCancel
}: FancyChoiceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const onSelectRef = useRef(onSelect);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onSelectRef.current = onSelect;
    onCancelRef.current = onCancel;
  }, [onSelect, onCancel]);

  const [shouldRender, setShouldRender] = useState(isVisible);
  const [prevIsVisible, setPrevIsVisible] = useState(isVisible);

  if (isVisible !== prevIsVisible) {
    setPrevIsVisible(isVisible);
    if (isVisible) {
      setShouldRender(true);
    }
  }

  useEffect(() => {
    if (isVisible) {
      if (containerRef.current) {
        Motion.to(containerRef.current, { opacity: 1, duration: 0.3, pointerEvents: 'auto' });
      }
      if (modalRef.current) {
        Motion.fromTo(modalRef.current,
          { scale: 0.92, opacity: 0, y: 20 },
          { scale: 1, opacity: 1, y: 0, duration: 0.5, ease: "expo.out" }
        );
      }

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancelRef.current();
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    } else {
      if (containerRef.current) {
        Motion.to(containerRef.current, {
          opacity: 0,
          duration: 0.2,
          pointerEvents: 'none',
          onComplete: () => {
            setShouldRender(false);
          }
        });
      }
      if (modalRef.current) {
        Motion.to(modalRef.current, { scale: 0.95, opacity: 0, y: 8, duration: 0.2 });
      }
    }
  }, [isVisible]);

  if (!shouldRender) return null;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[6000] flex items-center justify-center p-4 bg-zinc-950/30 backdrop-blur-[2px] opacity-0 pointer-events-none"
    >
      <div
        ref={modalRef}
        className="relative w-full max-w-[380px] bg-[var(--bg-panel)] backdrop-blur-3xl rounded-2xl border border-[var(--border-light)] shadow-[0_32px_80px_rgba(0,0,0,0.25)] overflow-hidden"
      >
        {/* Title bar: title left + close button right, same line */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <h3 className="text-[var(--text-main)] text-base font-black tracking-tight leading-tight">
            {title}
          </h3>
          <button
            onClick={onCancel}
            className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center
              bg-[var(--bg-stage)] dark:bg-white/[0.04]
              border border-[var(--border-subtle)] dark:border-white/[0.08]
              hover:bg-[var(--bg-panel)] dark:hover:bg-white/[0.08]
              hover:border-[var(--border-light)]
              text-[var(--text-muted)] hover:text-[var(--text-main)]
              transition-all duration-200 cursor-pointer"
          >
            <X size={14} strokeWidth={2.5} />
          </button>
        </div>

        {/* Option cards */}
        <div className="px-5 pb-6 space-y-2.5">
          {options.map((opt) => {
            const Icon = opt.icon;
            const hasGradient = !!opt.iconGradient;
            return (
              <button
                key={opt.id}
                onClick={() => onSelect(opt.id)}
                className="group relative w-full flex items-center gap-4 px-4 py-3.5 rounded-xl
                  border border-[var(--border-subtle)] dark:border-white/[0.08]
                  bg-[var(--bg-stage)]/40 dark:bg-white/[0.02]
                  hover:bg-[var(--bg-panel)]/80 dark:hover:bg-white/[0.06]
                  hover:border-[var(--border-light)] dark:hover:border-white/[0.15]
                  hover:shadow-md dark:hover:shadow-lg dark:hover:shadow-black/20
                  transition-all duration-200 cursor-pointer active:scale-[0.98]"
              >
                {/* Icon */}
                {Icon && (
                  <div className={`relative flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200 overflow-hidden
                    ${hasGradient
                      ? 'bg-[var(--bg-stage)] dark:bg-white/[0.04] border border-[var(--border-subtle)] dark:border-white/[0.06] group-hover:border-transparent group-hover:shadow-md'
                      : 'bg-[var(--bg-stage)] dark:bg-white/[0.04] border border-[var(--border-subtle)] dark:border-white/[0.06] group-hover:border-[var(--border-light)]'
                    }
                  `}>
                    {/* Gradient background on hover */}
                    {hasGradient && (
                      <div className={`absolute inset-0 bg-gradient-to-br ${opt.iconGradient} opacity-0 group-hover:opacity-100 transition-opacity duration-200`} />
                    )}
                    <Icon
                      size={16}
                      strokeWidth={2}
                      className={`relative z-[1] transition-colors duration-200 text-[var(--text-muted)] ${
                        hasGradient
                          ? 'group-hover:text-white'
                          : 'group-hover:text-[var(--text-main)]'
                      }`}
                    />
                  </div>
                )}
                {/* Text */}
                <div className="flex-1 text-left min-w-0">
                  <div className="text-sm font-bold text-[var(--text-muted)] group-hover:text-[var(--text-main)] transition-colors duration-200">
                    {opt.label}
                  </div>
                  {opt.description && (
                    <div className="text-[10px] text-[var(--text-muted)]/50 group-hover:text-[var(--text-muted)]/80 mt-0.5 transition-colors duration-200">
                      {opt.description}
                    </div>
                  )}
                </div>

                {/* Subtle hover glow */}
                <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none bg-gradient-to-r from-transparent via-white/[0.01] to-transparent" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
