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

"use client";

import { Sparkle, Stamp } from "lucide-react";

/**
 * MosaicIcon: Custom icon — 2×2 grid with diagonal cells filled.
 *
 * Visual concept:
 *   ┌────┬────┐
 *   │ ■■ │    │   ← Filled cells create a mosaic/pixelation motif
 *   ├────┼────┤
 *   │    │ ■■ │
 *   └────┴────┘
 *
 * Matches lucide icon style (24×24 viewBox, currentColor stroke/fill,
 * rounded corners, 2px stroke width).
 */
export function MosaicIcon({ size = 20, className }: { size?: number; className?: string } = {}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Checkerboard filled cells (solid currentColor, no opacity) */}
      <rect x="3" y="3" width="9" height="9" rx="1" fill="currentColor" />
      <rect x="12" y="12" width="9" height="9" rx="1" fill="currentColor" />
      {/* Outer border (rounded rect) */}
      <rect
        x="3" y="3" width="18" height="18" rx="2"
        stroke="currentColor" strokeWidth="2" fill="none"
      />
      {/* Center grid lines */}
      <line x1="12" y1="3" x2="12" y2="21" stroke="currentColor" strokeWidth="2" />
      <line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/**
 * CraftDrawerIcon: Custom icon showing "T" (text) and paintbrush, split by diagonal.
 *
 * Visual concept:
 *   ┌─────────┐
 *   │ T  ╱    │   ← Upper-left: lucide Type icon (text tool)
 *   │  ╱ 🖌️   │   ← Lower-right: lucide Paintbrush icon (brush tool)
 *   └─────────┘
 *
 * Uses SVG path data from lucide icons (Type + Paintbrush), each scaled to 55%
 * and positioned in their respective quadrants. Diagonal divider line matches
 * BgRemovalIcon's style (bottom-left to top-right, rounded caps, 0.85 opacity).
 */
export function CraftDrawerIcon({ size = 20, className }: { size?: number; className?: string } = {}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Lucide "Type" icon paths — scaled and positioned in upper-left quadrant */}
      <g
        transform="translate(-1, -1) scale(0.58)"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        <polyline points="4 7 4 4 20 4 20 7" />
        <line x1="9" x2="15" y1="20" y2="20" />
        <line x1="12" x2="12" y1="4" y2="20" />
      </g>

      {/* Lucide "Paintbrush" icon paths — scaled and positioned in lower-right quadrant */}
      <g
        transform="translate(10.5, 10.5) scale(0.58)"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        <path d="M18.37 2.63 14 7l-1.59-1.59a2 2 0 0 0-2.82 0L8 7l9 9 1.59-1.59a2 2 0 0 0 0-2.82L17 10l4.37-4.37a2.12 2.12 0 1 0-3-3Z" />
        <path d="M9 8c-2 3-4 3.5-7 4l8 10c2-1 6-5 6-7" />
        <path d="M14.5 17.5 4.5 15" />
      </g>

      {/* Diagonal divider line (bottom-left to top-right) */}
      <line
        x1="4"
        y1="20"
        x2="20"
        y2="4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.85"
      />
    </svg>
  );
}

// ─── Retouch mode icons (mosaic craft button sub-modes) ────────────────────────

/**
 * Retouch mode icons: one glyph per mosaic-overlay sub-mode, drawn in the
 * same lucide idiom as MosaicIcon (24×24 viewBox, currentColor, 2px stroke).
 * They label the panel's mode switch and drive the toolbar's dynamic
 * retouch trigger icon (the toolbar shows the LAST USED mode, not a fixed
 * mosaic glyph).
 */

/** HealIcon: spot-heal — a rounded patch (band-aid) with suture dots. */
export function HealIcon({ size = 20, className }: { size?: number; className?: string } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <g transform="rotate(45 12 12)">
        <rect x="3" y="8" width="18" height="8" rx="4" stroke="currentColor" strokeWidth="2" />
        <line x1="12" y1="8" x2="12" y2="16" stroke="currentColor" strokeWidth="2" strokeDasharray="1.5 2" />
        <circle cx="7.5" cy="12" r="0.8" fill="currentColor" />
        <circle cx="16.5" cy="12" r="0.8" fill="currentColor" />
      </g>
    </svg>
  );
}

/** DoubleSquareIcon: a solid square doubled by a dashed twin — previously the
 * clone glyph, now the blur glyph (source run repeated elsewhere). */
export function DoubleSquareIcon({ size = 20, className }: { size?: number; className?: string } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
      <rect x="3" y="3" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="2" strokeDasharray="3 2.5" />
    </svg>
  );
}

/** BlurIcon: blur — a circle dissolving into scattered dots (soft focus). */
export function BlurIcon({ size = 20, className }: { size?: number; className?: string } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <circle cx="10" cy="12" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="2 2.5" />
      <circle cx="18" cy="6" r="1.2" fill="currentColor" />
      <circle cx="20" cy="12" r="1" fill="currentColor" opacity="0.7" />
      <circle cx="18.5" cy="17.5" r="0.8" fill="currentColor" opacity="0.45" />
    </svg>
  );
}

/** SharpenIcon: sharpen — the lucide Sparkle glyph (crisp highlight). */
export function SharpenIcon({ size = 20, className }: { size?: number; className?: string } = {}) {
  return <Sparkle size={size} className={className} aria-hidden="true" />;
}

/** StampIcon: clone stamp — the lucide Stamp glyph (rubber stamp). */
export function StampIcon({ size = 20, className }: { size?: number; className?: string } = {}) {
  return <Stamp size={size} className={className} aria-hidden="true" />;
}

/** Map of every retouch mode to its glyph, shared by the panel switch and the dynamic toolbar trigger. */
export const RETOUCH_MODE_ICONS = {
  mosaic: MosaicIcon,
  heal: HealIcon,
  blur: DoubleSquareIcon,
  sharpen: SharpenIcon,
  clone: StampIcon,
} as const;
