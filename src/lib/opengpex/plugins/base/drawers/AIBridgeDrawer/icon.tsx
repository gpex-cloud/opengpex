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
 * AIBridgeIcon: Modern sidebar icon — bold "AI" text + sparkle (top-right) + link chain (bottom-right).
 *
 * The busy/generating animation is now handled generically by DrawerBar via
 * the PluginService.isBusy() mechanism — no per-plugin animation code needed.
 *
 * Design:
 * • Bold "AI" text (left) — immediate recognition.
 * • 4-pointed sparkle star (top-right) — modern AI indicator.
 * • Link/chain icon (bottom-right) — echoes "Bridge" name, indicates connection to external API.
 *
 * Visual layout (24×24 viewBox):
 *   ┌────────────────────────┐
 *   │               ✦        │  sparkle (top-right)
 *   │  ██   ██              │
 *   │  █ █   █              │  Bold "AI" (left)
 *   │  ███   █              │
 *   │  █ █   █              │
 *   │  █ █  ███    🔗       │  Link/chain (bottom-right)
 *   └────────────────────────┘
 */
export function AIBridgeIcon({ size = 24, className }: { size?: number; className?: string } = {}) {
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
      {/* 1. "AI" Text — Shifted upward (y changed from 18 to 15) */}
      <text
        x="0"
        y="15"
        fontSize="14"
        fontWeight="900"
        fill="currentColor"
        fontFamily="system-ui, -apple-system, sans-serif"
        letterSpacing="-0.5"
      >
        AI
      </text>

      {/* 2. Chain Link Group — Translated downward and rotated 90 degrees */}
      <g
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
        opacity="0.75"
        transform="translate(0, 1.5) rotate(90, 18, 16.5)"
      >
        {/* Upper Link */}
        <rect x="15" y="12" width="3.5" height="6" rx="1.75" transform="rotate(-45, 16.75, 15)" />
        {/* Lower Link */}
        <rect x="17.5" y="16" width="3.5" height="6" rx="1.75" transform="rotate(-45, 19.25, 19)" />
      </g>
    </svg>
  );
}
