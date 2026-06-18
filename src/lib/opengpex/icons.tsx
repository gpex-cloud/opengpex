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

