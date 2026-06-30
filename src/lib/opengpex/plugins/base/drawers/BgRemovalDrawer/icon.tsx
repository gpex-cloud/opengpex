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
 * BgRemovalIcon: Custom "BG" text icon with horizontal strikethrough.
 *
 * Visual:
 *   ┌─────┐
 *   │ B̶G̶  │  ← Large "BG" text + horizontal delete line through center
 *   └─────┘
 *
 * Uses inline SVG for full control over text positioning and line rendering.
 * The horizontal line uses `stroke-linecap: round` for polished endpoints.
 */
export function BgRemovalIcon({ size = 20, className }: { size?: number; className?: string } = {}) {
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
