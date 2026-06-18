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
import EditorHUD from './EditorHUD';
import { Loader2 } from 'lucide-react';

interface FancyOverlayProps {
  /** Control if overlay is visible */
  isVisible: boolean;
  /** Main title text, default: "Initializing Workspace" */
  title?: string;
  /** Subtitle text, default: "Finalizing page load..." */
  subtitle?: string;
  /** Extra container class name */
  className?: string;
  /** Custom style */
  style?: React.CSSProperties;
}

/**
 * [FIX] Uses pure CSS animate-in instead of Motion.fromTo useEffect.
 * The previous JS-driven animation was re-triggered by React Strict Mode (double-mount)
 * causing the overlay to flash/appear twice on page refresh.
 * CSS animation only plays once on DOM mount, immune to strict mode.
 */
export default function FancyOverlay({
  isVisible,
  title = "Initializing Workspace",
  subtitle = "Finalizing page load...",
  className = "",
  style
}: FancyOverlayProps) {
  if (!isVisible) return null;

  return (
    <div 
      className={`absolute inset-0 z-[100] flex items-center justify-center pointer-events-none px-4 bg-zinc-950/20 dark:bg-zinc-900/30 backdrop-blur-sm animate-in fade-in duration-300 ${className}`}
      style={style}
    >
      <EditorHUD 
        isVisible={isVisible}
        title={title}
        subtitle={subtitle}
        yOffset={10}
        icon={
          <div className="flex-shrink-0 flex items-center justify-center w-5 h-5 rounded-full bg-indigo-500 shadow-lg shadow-indigo-500/20">
            <Loader2 size={11} className="text-white animate-spin" strokeWidth={3} />
          </div>
        }
      />
    </div>
  );
}
