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
import { Eye, EyeOff } from 'lucide-react';
import ActionButton from '@opengpex/editor/widgets/ActionButton';

interface ChannelItemProps {
  /** Channel identifier for display */
  channelKey: string;
  label: string;
  /** Accent color for the channel swatch and active indicator */
  color?: string;
  /** Gradient for the RGB composite swatch */
  gradient?: string;
  /** Whether this channel is currently visible (eye on) */
  visible: boolean;
  /** Whether this channel is the "active" one (highlighted row) — true when it's the sole visible channel */
  isActive: boolean;
  /** Subtitle text (e.g. "composite", "transparency") */
  subtitle?: string;
  /** Toggle eye visibility */
  onToggleVisibility: () => void;
  /** Click on the channel row (select for solo viewing) */
  onSelect: () => void;
}

/**
 * ChannelItem: Individual channel row in the Channels panel.
 * Visually mirrors LayerItem — 36px card with thumbnail swatch, name, and eye toggle.
 *
 * Interaction model (Photoshop-like):
 * - Click eye icon: Toggle this channel's visibility (multi-select, shows in color)
 * - Click channel name/row: Solo this channel as grayscale
 */
export const ChannelItem = React.memo(function ChannelItem({
  label,
  color,
  gradient,
  visible,
  isActive,
  subtitle,
  onToggleVisibility,
  onSelect,
}: ChannelItemProps) {
  return (
    <div
      className={`group/channel relative flex items-center h-[32px] cursor-pointer transition-opacity
        ${!visible ? 'opacity-50' : 'opacity-100'}
      `}
      onClick={onSelect}
    >
      {/* Background + ring */}
      <div
        className={`absolute top-0 bottom-0 right-0 left-0 rounded-lg transition-all duration-200 pointer-events-none
          ${isActive
            ? 'bg-[var(--bg-stage)] ring-1 ring-[var(--border-light)]'
            : 'ring-1 ring-transparent group-hover/channel:bg-[var(--bg-stage)] group-hover/channel:ring-[var(--border-light)]'
          }
        `}
      >
        {/* Active indicator bar (left edge) */}
        {isActive && (
          <div
            className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full shadow-[0_0_8px_rgba(99,102,241,0.4)] transition-all duration-300"
            style={{ backgroundColor: color || '#6366f1' }}
          />
        )}
      </div>

      {/* Content row */}
      <div className="relative z-10 flex-1 flex items-center h-full px-1.5 gap-2">
        {/* Channel color swatch (mimics LayerItem thumbnail) */}
        <div
          className={`relative w-[24px] h-[24px] shrink-0 rounded-md border overflow-hidden flex items-center justify-center transition-all
            ${isActive
              ? 'border-[var(--border-light)] bg-[var(--bg-panel)] shadow-sm'
              : 'border-[var(--border-subtle)] bg-[var(--bg-stage)]/40 group-hover/channel:border-[var(--border-light)] group-hover/channel:shadow-sm'
            }
            ${!visible ? 'grayscale' : ''}
          `}
        >
          {gradient ? (
            <div
              className="w-full h-full rounded-[inherit]"
              style={{ background: gradient }}
            />
          ) : (
            <div
              className="w-full h-full flex items-center justify-center rounded-[inherit]"
              style={{ backgroundColor: color ? `${color}20` : '#71717a20' }}
            >
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: color || '#71717a' }}
              />
            </div>
          )}
        </div>

        {/* Channel name */}
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <span
            className={`text-[11px] font-bold truncate transition-colors leading-tight tracking-tight
              ${isActive ? 'text-[var(--text-main)]' : 'text-[var(--text-muted)] group-hover/channel:text-[var(--text-main)]'}
            `}
          >
            {label}
          </span>
          {subtitle && (
            <span className="text-[8px] font-bold text-[var(--text-muted)] uppercase tracking-wider opacity-60">
              {subtitle}
            </span>
          )}
        </div>

        {/* Eye toggle (visibility) */}
        <div className="flex items-center gap-0 opacity-40 group-hover/channel:opacity-100 transition-opacity">
          <ActionButton
            onClick={(e) => {
              e.stopPropagation();
              onToggleVisibility();
            }}
            icon={
              visible ? (
                <Eye size={12} />
              ) : (
                <EyeOff size={12} className="text-rose-500" />
              )
            }
            variant="glass"
            size="sm"
            className={`w-6 h-6 ${visible ? (isActive ? 'text-indigo-400' : 'text-[var(--text-main)]') : ''}`}
          />
        </div>
      </div>
    </div>
  );
});
