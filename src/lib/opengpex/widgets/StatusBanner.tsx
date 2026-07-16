/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

'use client';

import React from 'react';

// ─── Variant Styles ────────────────────────────────────────────────────────────

const VARIANT_STYLES = {
  rose: {
    container: 'bg-rose-50/80 border-rose-200/80 dark:bg-rose-950/40 dark:border-rose-800/40 dark:shadow-[0_0_15px_rgba(251,113,133,0.1)]',
    icon: 'text-rose-500 dark:text-rose-400',
    title: 'text-rose-700 dark:text-rose-300',
  },
  amber: {
    container: 'bg-amber-50/80 border-amber-200/80 dark:bg-amber-950/30 dark:border-amber-500/30',
    icon: 'text-amber-600 dark:text-amber-400',
    title: 'text-amber-800 dark:text-amber-300',
  },
  emerald: {
    container: 'bg-emerald-50/80 border-emerald-200/80 dark:bg-emerald-950/30 dark:border-emerald-500/30',
    icon: 'text-emerald-600 dark:text-emerald-400',
    title: 'text-emerald-700 dark:text-emerald-300',
  },
  blue: {
    container: 'bg-blue-50/80 border-blue-200/80 dark:bg-blue-950/30 dark:border-blue-500/30',
    icon: 'text-blue-600 dark:text-blue-400',
    title: 'text-blue-700 dark:text-blue-300',
  },
} as const;

export type StatusBannerVariant = keyof typeof VARIANT_STYLES;

// ─── Props ─────────────────────────────────────────────────────────────────────

interface StatusBannerProps {
  /** Color variant: rose (error), amber (warning), emerald (success), blue (info) */
  variant: StatusBannerVariant;
  /** Icon element (e.g. lucide-react icon) */
  icon: React.ReactNode;
  /** Primary message text */
  title: string;
  /** Optional secondary description text */
  description?: string;
  /** Additional className for the container */
  className?: string;
}

// ─── Component ─────────────────────────────────────────────────────────────────

/**
 * StatusBanner — A compact colored banner for displaying status messages.
 *
 * Supports light/dark mode with semantic color variants.
 * Used for connection status, input requirements, validation messages, etc.
 */
export default function StatusBanner({ variant, icon, title, description, className }: StatusBannerProps) {
  const styles = VARIANT_STYLES[variant];

  return (
    <div className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-colors dark:backdrop-blur-sm ${styles.container} ${className || ''}`}>
      <span className={`shrink-0 ${styles.icon}`}>
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <p className={`text-[10px] font-bold antialiased tracking-wide ${styles.title}`}>
          {title}
        </p>
        {description && (
          <p className="text-[9px] text-[var(--text-muted)] mt-1 antialiased leading-relaxed">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
