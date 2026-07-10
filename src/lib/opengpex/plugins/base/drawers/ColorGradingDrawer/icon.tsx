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
 * ColorGradingDrawerIcon — composite icon representing "curves + levels" tools.
 *
 * Visual concept (mirrors CraftDrawerIcon's split-quadrant grammar so the
 * sidebar reads as "a family of icon-switch drawers"):
 *
 *   ┌─────────┐
 *   │∿  ╱     │  ← Upper-left quadrant: bold tone-curve S with endpoint dots
 *   │  ╱ ▄▆█  │  ← Lower-right quadrant: bold 3-bar histogram
 *   └─────────┘
 *
 * Sizing/weight rationale (matches CraftDrawerIcon exactly):
 *   - 24×24 viewBox
 *   - each sub-glyph occupies ~55–65% of its quadrant (previously < 30%,
 *     which made the whole icon feel undersized in the sidebar at 12–20px)
 *   - stroke-width: 3.5 on sub-glyphs (was 2 → looked wispy at 12px), 2 on
 *     the diagonal divider (was 1.5)
 *   - diagonal divider opacity: 0.85 (was 0.35 → nearly invisible; the whole
 *     "split-quadrant" family relies on the diagonal being clearly visible
 *     as the identifying motif)
 *   - line-caps: round on everything, matching CraftDrawerIcon
 */
export function ColorGradingDrawerIcon({
  size = 20,
  className,
}: { size?: number; className?: string } = {}) {
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
      {/*
        Upper-left quadrant: tone-curve S.
        Path goes from (2, 12) rising up through a control-point curve to
        (12, 2) — i.e. sweeps the full upper-left triangle. Endpoint dots
        (r=1.4) mark the "shadow" and "highlight" anchor points, giving it
        the recognizable Curves-panel affordance.
      */}
      <path
        d="M2 12 C 5 12, 6.5 3.5, 12 2"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="2" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="2" r="1.6" fill="currentColor" />

      {/*
        Lower-right quadrant: three histogram bars.
        Bars run from y=22 up to y=18/14/16 — a low/high/mid silhouette that
        reads unambiguously as a levels/histogram widget. x positions 14/18/22
        keep them tucked against the right edge, mirroring how CraftDrawer's
        paintbrush sits in the same quadrant.
      */}
      <g
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      >
        <line x1="14" y1="22" x2="14" y2="18" />
        <line x1="18" y1="22" x2="18" y2="12" />
        <line x1="22" y1="22" x2="22" y2="15" />
      </g>

      {/*
        Diagonal divider — the shared identifying motif of the "split-quadrant"
        icon family (also seen in CraftDrawerIcon, BgRemovalIcon). Same stroke
        weight and opacity as CraftDrawerIcon so the family reads as one set.
      */}
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
