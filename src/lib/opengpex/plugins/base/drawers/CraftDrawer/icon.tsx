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
