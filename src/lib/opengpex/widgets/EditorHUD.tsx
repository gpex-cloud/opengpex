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

import React, { useEffect, useRef } from 'react';
import { Motion } from '@opengpex/editor/core/motion';

interface EditorHUDProps {
  /** Whether visible */
  isVisible?: boolean;
  /** Icon element */
  icon: React.ReactNode;
  /** Main title */
  title: string;
  /** Subtitle */
  subtitle: string;
  /** Extra container class name */
  className?: string;
  /** Animation config: y offset */
  yOffset?: number;
}

/**
 * EditorHUD: Flagship version generic capsule floating HUD component (Slim Edition)
 * Unifies HUD interaction language: glassy look, compact spacing, extreme simplicity.
 */
export default function EditorHUD({
  isVisible = true,
  icon,
  title,
  subtitle,
  className = "",
  yOffset = 20
}: EditorHUDProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isVisible && ref.current) {
      Motion.fromTo(ref.current, 
        { opacity: 0, scale: 0.95, y: yOffset }, 
        { opacity: 1, scale: 1, y: 0, duration: 0.4, ease: "expo.out", overwrite: "auto" }
      );
    }
  }, [isVisible, yOffset]);

  if (!isVisible) return null;

  return (
    <div
      ref={ref}
      className={`flex items-center gap-2.5 px-4 py-2 bg-zinc-900/90 dark:bg-white/95 backdrop-blur-3xl rounded-full border border-white/10 dark:border-zinc-200 shadow-[0_12px_40px_rgba(0,0,0,0.25)] dark:shadow-[0_12px_40px_rgba(0,0,0,0.1)] ${className}`}
    >
      {/* Icon Wrapper: Now smaller and more precise */}
      <div className="flex-shrink-0 flex items-center justify-center">
        <span className="text-white dark:text-zinc-900 scale-90">{icon}</span>
      </div>

      {/* Text Content: Tighter line height and condensed fonts */}
      <div className="flex flex-col pr-0.5 text-left leading-[1.1]">
        <span className="text-[11px] font-black text-zinc-100 dark:text-zinc-950 tracking-tight whitespace-nowrap italic uppercase">
          {title}
        </span>
        <span className="text-[8px] text-zinc-500 font-bold whitespace-nowrap uppercase tracking-[0.15em] opacity-80">
          {subtitle}
        </span>
      </div>
    </div>
  );
}
