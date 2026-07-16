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
 * AIToolsIcon: Drawer sidebar icon — bold "AI" text + wrench graphic.
 *
 * Design:
 * • Bold "AI" text (upper-left) — immediate recognition.
 * • Wrench icon (lower-right, tilted -40°) — universal "tools" metaphor,
 *   replaces the previous tiny unreadable "Tools" text (8.5px).
 * • The wrench consists of a rounded handle bar + open-end jaw head.
 *
 * Visual layout (24×24 viewBox):
 *   ┌────────────────────────┐
 *   │  ██   ██              │
 *   │  █ █   █              │  Bold "AI" (upper-left)
 *   │  ███   █              │
 *   │  █ █   █     🔧      │
 *   │  █ █  ███   /        │  Wrench (lower-right, tilted)
 *   │            /          │
 *   └────────────────────────┘
 */
export function AIToolsIcon({ size = 24, className }: { size?: number; className?: string } = {}) {
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
      {/* Bold "AI" — upper-left, prominent */}
      <text
        x="1"
        y="13"
        fontSize="13"
        fontWeight="900"
        fill="currentColor"
        fontFamily="system-ui, -apple-system, sans-serif"
        letterSpacing="-0.5"
      >
        AI
      </text>

      {/* Wrench — lower-right area, tilted -40° for dynamic feel */}
      <g transform="translate(15, 19) rotate(-40)" fill="currentColor">
        {/* Handle: rounded bar */}
        <rect x="-7" y="-1.2" width="8.5" height="2.4" rx="1.2" />
        {/* Head with open jaw (U-shape opening on the right) */}
        <path d="M1.5 -2.6 L5.2 -2.6 L5.2 -0.7 L3.8 -0.7 L3.8 0.7 L5.2 0.7 L5.2 2.6 L1.5 2.6 Z" />
      </g>
    </svg>
  );
}

/**
 * BgRemoverIcon: Custom "BG" text icon with horizontal strikethrough.
 *
 * Visual:
 *   ┌─────┐
 *   │ B̶G̶  │  ← Large "BG" text + horizontal delete line through center
 *   └─────┘
 *
 * Uses inline SVG for full control over text positioning and line rendering.
 * The horizontal line uses `stroke-linecap: round` for polished endpoints.
 */
export function BgRemoverIcon({ size = 20, className }: { size?: number; className?: string } = {}) {
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
      {/* "BG" text — extra large and bold for maximum readability */}
      <text
        x="12"
        y="18"
        textAnchor="middle"
        fontSize="17"
        fontWeight="900"
        fill="currentColor"
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        BG
      </text>
      {/* Strikethrough line — top-left to bottom-right, extends beyond text */}
      <line
        x1="0"
        y1="5"
        x2="24"
        y2="19"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity="0.9"
      />
    </svg>
  );
}
