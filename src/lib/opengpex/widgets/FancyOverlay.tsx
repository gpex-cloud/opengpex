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

import React, { useState } from 'react';
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
 *
 * Fade-out also stays pure CSS (delayed unmount): when `isVisible` drops, the
 * container switches to the `gpex-overlay-out` animation (defined in
 * app/globals.css — Tailwind's animate-in/animate-out utilities are NOT
 * available in this project) and unmounts on animationend.
 * Do NOT replace this with Motion/JS-driven animation — Strict Mode double-mount
 * replays JS animations (see the animate-in lesson above).
 */
export default function FancyOverlay({
  isVisible,
  title = "Initializing Workspace",
  subtitle = "Finalizing page load...",
  className = "",
  style
}: FancyOverlayProps) {
  // Delayed unmount: keep rendering through the CSS fade-out. The previous-
  // prop pair implements the React-recommended "adjust state during render"
  // pattern (no setState-in-effect cascading render).
  const [prevVisible, setPrevVisible] = useState(isVisible);
  const [shouldRender, setShouldRender] = useState(isVisible);

  if (prevVisible !== isVisible) {
    setPrevVisible(isVisible);
    if (isVisible) setShouldRender(true);
  }

  if (!shouldRender) return null;

  return (
    <div
      className={`absolute inset-0 z-[100] flex items-center justify-center pointer-events-none px-4 bg-zinc-950/20 dark:bg-zinc-900/30 backdrop-blur-sm ${isVisible ? 'gpex-overlay-in' : 'gpex-overlay-out'} ${className}`}
      style={style}
      onAnimationEnd={(e) => {
        // Only the container's own fade-out ends the render lifetime —
        // animationend bubbles from children (e.g. the spinner).
        if (!isVisible && e.target === e.currentTarget) setShouldRender(false);
      }}
    >
      <EditorHUD
        isVisible={isVisible}
        title={title}
        subtitle={subtitle}
        yOffset={10}
        icon={
          <div className="flex-shrink-0 flex items-center justify-center w-5 h-5 rounded-full bg-indigo-500 shadow-lg shadow-indigo-500/20">
            {/* spin-lite, not animate-spin: this spinner sits over a
                backdrop-blur surface (see globals.css "-lite" note). */}
            <Loader2 size={11} className="text-white animate-spin-lite" strokeWidth={3} />
          </div>
        }
      />
    </div>
  );
}
