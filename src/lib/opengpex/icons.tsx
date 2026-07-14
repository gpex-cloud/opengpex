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

/**
 * Custom SVG: Merge Down Icon
 * Representation: two horizontal lines at the top and bottom, with a merge-down arrow in the middle
 */
export function MergeDownIcon({ size = 12 }: { size?: number }) {
  return (
    <svg 
      viewBox="0 0 16 16" 
      width={size} 
      height={size} 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
      className="lucide-icon"
    >
      {/* Top layer */}
      <path d="M2 3h12" />
      
      {/* Down arrow - leaving a 2.5px symmetrical gap with upper and lower layers */}
      <path d="M8 5.5v3.5" />
      <path d="M5.5 9L8 11.5l2.5-2.5" />
      
      {/* Bottom layer */}
      <path d="M2 14h12" />
    </svg>
  );
}

/**
 * Custom SVG: Merge Visible Icon
 * Representation: 4 short lines arranged in descending order on the left, sorting down arrow on the right
 */
export function MergeVisibleIcon({ size = 12 }: { size?: number }) {
  return (
    <svg 
      viewBox="0 0 16 16" 
      width={size} 
      height={size} 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
      className="lucide-icon"
    >
      {/* Left side: 4 short lines arranged in descending order (perfectly dividing the space from Y=3 to Y=13) */}
      <path d="M2 3h6.5" />
      <path d="M2 6.3h5.5" />
      <path d="M2 9.7h4.5" />
      <path d="M2 13h5" />
      
      {/* Right side: elegant sorting down arrow */}
      <path d="M12 3v10" />
      <path d="M9.5 10.5L12 13l2.5-2.5" />
    </svg>
  );
}

/**
 * TEXT_PREEDIT_CURSOR: Custom cursor for pre-edit state
 * Appearance: a small arrow pointer in the top-left corner + T character in the bottom-right
 * Hotspot: (3, 1) - tip of the arrow
 */
export const TEXT_PREEDIT_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill='none'%3E%3C!-- Arrow pointer (top-left) --%3E%3Cpath d='M3 1 L3 14 L6.5 10.5 L9.5 16 L11.5 15 L8.5 9 L13 9 Z' fill='white' stroke='black' stroke-width='1' stroke-linejoin='round'/%3E%3C!-- T character (bottom-right) --%3E%3Cpath d='M14 13 L22 13 M18 13 L18 23' stroke='white' stroke-width='2.5' stroke-linecap='round'/%3E%3Cpath d='M14 13 L22 13 M18 13 L18 23' stroke='black' stroke-width='1' stroke-linecap='round'/%3E%3C/svg%3E") 3 1, default`;

// ─── Clip Tool Cursors ─────────────────────────────────────────────────────────
// Each clip tool has a unique cursor: crosshair (center) + tool badge (bottom-right).
// 24×24 SVG, hotspot at crosshair center (8,8), fallback: crosshair.
// Double-stroke (white thick + black thin) ensures visibility on all backgrounds.

/**
 * CLIP_RECT_CURSOR: Crosshair + small square badge
 * Hotspot: (8, 8)
 */
export const CLIP_RECT_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill='none'%3E%3Cpath d='M8 1v5M8 11v5M1 8h5M11 8h5' stroke='white' stroke-width='2' stroke-linecap='round'/%3E%3Cpath d='M8 1v5M8 11v5M1 8h5M11 8h5' stroke='black' stroke-width='1' stroke-linecap='round'/%3E%3Crect x='15' y='15' width='7' height='7' rx='1' stroke='white' stroke-width='2.5' fill='none'/%3E%3Crect x='15' y='15' width='7' height='7' rx='1' stroke='black' stroke-width='1' fill='none'/%3E%3C/svg%3E") 8 8, crosshair`;

/**
 * CLIP_ELLIPSE_CURSOR: Crosshair + small circle badge
 * Hotspot: (8, 8)
 */
export const CLIP_ELLIPSE_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill='none'%3E%3Cpath d='M8 1v5M8 11v5M1 8h5M11 8h5' stroke='white' stroke-width='2' stroke-linecap='round'/%3E%3Cpath d='M8 1v5M8 11v5M1 8h5M11 8h5' stroke='black' stroke-width='1' stroke-linecap='round'/%3E%3Ccircle cx='18.5' cy='18.5' r='3.5' stroke='white' stroke-width='2.5' fill='none'/%3E%3Ccircle cx='18.5' cy='18.5' r='3.5' stroke='black' stroke-width='1' fill='none'/%3E%3C/svg%3E") 8 8, crosshair`;

/**
 * CLIP_LASSO_CURSOR: Crosshair + freehand curve badge
 * Hotspot: (8, 8)
 */
export const CLIP_LASSO_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill='none'%3E%3Cpath d='M8 1v5M8 11v5M1 8h5M11 8h5' stroke='white' stroke-width='2' stroke-linecap='round'/%3E%3Cpath d='M8 1v5M8 11v5M1 8h5M11 8h5' stroke='black' stroke-width='1' stroke-linecap='round'/%3E%3Cpath d='M15 20c1-3 3-5 5-5s3 2 3 3.5c0 2-2 3-4 2.5' stroke='white' stroke-width='2.5' stroke-linecap='round' fill='none'/%3E%3Cpath d='M15 20c1-3 3-5 5-5s3 2 3 3.5c0 2-2 3-4 2.5' stroke='black' stroke-width='1' stroke-linecap='round' fill='none'/%3E%3C/svg%3E") 8 8, crosshair`;

/**
 * CLIP_WAND_CURSOR: Crosshair + magic wand badge (angled stick + sparkle)
 * Hotspot: (8, 8)
 */
export const CLIP_WAND_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill='none'%3E%3Cpath d='M8 1v5M8 11v5M1 8h5M11 8h5' stroke='white' stroke-width='2' stroke-linecap='round'/%3E%3Cpath d='M8 1v5M8 11v5M1 8h5M11 8h5' stroke='black' stroke-width='1' stroke-linecap='round'/%3E%3Cpath d='M15 22l6-6' stroke='white' stroke-width='2.5' stroke-linecap='round'/%3E%3Cpath d='M15 22l6-6' stroke='black' stroke-width='1' stroke-linecap='round'/%3E%3Cpath d='M19 14v-1M20 15h1M17 15h-1M19 17v1' stroke='white' stroke-width='2' stroke-linecap='round'/%3E%3Cpath d='M19 14v-1M20 15h1M17 15h-1M19 17v1' stroke='black' stroke-width='0.8' stroke-linecap='round'/%3E%3C/svg%3E") 8 8, crosshair`;

/**
 * CLIP_SAM_CURSOR: Crosshair + AI brain/network badge (small neural-net icon)
 * Hotspot: (8, 8)
 */
export const CLIP_SAM_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill='none'%3E%3Cpath d='M8 1v5M8 11v5M1 8h5M11 8h5' stroke='white' stroke-width='2' stroke-linecap='round'/%3E%3Cpath d='M8 1v5M8 11v5M1 8h5M11 8h5' stroke='black' stroke-width='1' stroke-linecap='round'/%3E%3Ccircle cx='18' cy='15' r='1.5' stroke='white' stroke-width='2'/%3E%3Ccircle cx='18' cy='15' r='1.5' stroke='black' stroke-width='0.8'/%3E%3Ccircle cx='15' cy='19' r='1.5' stroke='white' stroke-width='2'/%3E%3Ccircle cx='15' cy='19' r='1.5' stroke='black' stroke-width='0.8'/%3E%3Ccircle cx='21' cy='19' r='1.5' stroke='white' stroke-width='2'/%3E%3Ccircle cx='21' cy='19' r='1.5' stroke='black' stroke-width='0.8'/%3E%3Cpath d='M18 16.5v1M16.2 18.3l-0.5 0.4M19.8 18.3l0.5 0.4' stroke='white' stroke-width='2' stroke-linecap='round'/%3E%3Cpath d='M18 16.5v1M16.2 18.3l-0.5 0.4M19.8 18.3l0.5 0.4' stroke='black' stroke-width='0.8' stroke-linecap='round'/%3E%3C/svg%3E") 8 8, crosshair`;

/**
 * InvertIcon: Square with a single diagonal from bottom-left to top-right.
 * Left half (below the diagonal) is filled black/currentColor.
 * Represents "invert selection" — two contrasting halves.
 * Based on lucide Square (24×24, rect 3,3 18×18 rx=2).
 */
export function InvertIcon({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`lucide-icon ${className || ''}`}
    >
      {/* Left half filled: triangle from bottom-left corner up the diagonal, clipped to rect */}
      <defs>
        <clipPath id="inv-clip">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        </clipPath>
      </defs>
      <polygon
        points="3,21 21,3 3,3"
        fill="currentColor"
        stroke="none"
        clipPath="url(#inv-clip)"
      />
      {/* Square outline */}
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      {/* Single diagonal: bottom-left to top-right */}
      <line x1="3" y1="21" x2="21" y2="3" />
    </svg>
  );
}

/**
 * AlphaIcon: Dashed single-stroke head+shoulders silhouette (no outer frame).
 * Represents "select from alpha" — the dashed outline evokes a
 * marching-ants selection around a person cutout.
 * One continuous path (one stroke) to visually read as a single contour.
 */
export function AlphaIcon({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray="2.5 2"
      className={`lucide-icon ${className || ''}`}
    >
      {/*
       * Single continuous path: start at left shoulder base → curve up to
       * left neck → head oval (top) → right neck → curve down to right
       * shoulder base. One stroke, no breaks.
       */}
      <path d="M3 21c0-4 2.5-7 5-8.5C6.5 11 5.5 9 5.5 7c0-3.6 2.9-5.5 6.5-5.5s6.5 1.9 6.5 5.5c0 2-1 4-2.5 5.5 2.5 1.5 5 4.5 5 8.5H3Z" />
    </svg>
  );
}

/**
 * PremiumCloud: Cyber Neon Cloud Icon
 * Used as trigger button for CloudMenu plugin
 */
export function PremiumCloudIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className={className}
      fill="url(#cloud-gradient)"
      stroke="none"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <defs>
        <linearGradient id="cloud-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#00F2FE" />
          <stop offset="100%" stopColor="#4FACFE" />
        </linearGradient>
      </defs>
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  );
}

