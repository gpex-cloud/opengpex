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

import React, { useState, useCallback, useEffect } from 'react';
import { useEditorServices } from '@opengpex/editor/core/context';
import {
  DISPLAY_CHANNEL_SIGNAL_KEY,
  deriveChannelMask,
  type ChannelVisibility,
} from '@opengpex/editor/core/engine/protocol/DisplayTransform';
import { ChannelItem } from './ChannelItem';

interface ChannelDef {
  key: 'r' | 'g' | 'b' | 'a';
  label: string;
  color?: string;
  gradient?: string;
  subtitle?: string;
}

const CHANNELS: ChannelDef[] = [
  { key: 'r', label: 'Red', color: '#ef4444' },
  { key: 'g', label: 'Green', color: '#22c55e' },
  { key: 'b', label: 'Blue', color: '#3b82f6' },
  { key: 'a', label: 'Alpha', color: '#a1a1aa', subtitle: 'transparency' },
];

const DEFAULT_VISIBILITY: ChannelVisibility = { r: true, g: true, b: true, a: false };

/**
 * ChannelsPanel: Displays channel list for channel view switching.
 * Uses Photoshop-like interaction model:
 * - Eye toggle: multi-select visibility (shows in color with disabled channels zeroed)
 * - Row click: solo that channel as grayscale
 *
 * Manages local ChannelVisibility state, derives ChannelMask, writes to signal.
 */
export function ChannelsPanel() {
  const { actions } = useEditorServices();
  const [visibility, setVisibility] = useState<ChannelVisibility>(DEFAULT_VISIBILITY);

  /** Sync derived ChannelMask to signal after every visibility state change.
   *  This runs in useEffect (after render) to avoid the React anti-pattern of
   *  updating a parent component (EditorProvider) during a child's render. */
  useEffect(() => {
    const mask = deriveChannelMask(visibility);
    actions.setStateSignal(DISPLAY_CHANNEL_SIGNAL_KEY, mask);
  }, [visibility, actions]);

  /** Toggle a single channel's eye visibility (multi-select) */
  const handleToggle = useCallback((key: 'r' | 'g' | 'b' | 'a') => {
    setVisibility((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      // Special: toggling Alpha ON implies solo alpha (disable RGB)
      if (key === 'a' && next.a) {
        return { r: false, g: false, b: false, a: true };
      }
      // Special: toggling any RGB ON disables alpha solo
      if (key !== 'a' && next[key]) {
        next.a = false;
      }
      // Safety: don't allow all RGB off (unless alpha is on)
      if (!next.r && !next.g && !next.b && !next.a) {
        next.r = true;
        next.g = true;
        next.b = true;
      }
      return next;
    });
  }, []);

  /** Solo a channel: show only that one as grayscale */
  const handleSolo = useCallback((key: 'r' | 'g' | 'b' | 'a') => {
    setVisibility({ r: key === 'r', g: key === 'g', b: key === 'b', a: key === 'a' });
  }, []);

  /** Click the RGB composite row: show all channels in color */
  const handleShowAll = useCallback(() => {
    setVisibility({ r: true, g: true, b: true, a: false });
  }, []);

  // Determine if we're showing composite (all RGB on)
  const isComposite = visibility.r && visibility.g && visibility.b && !visibility.a;

  return (
    <div className="flex flex-col gap-0.5 px-1 py-1">
      {/* RGB Composite row */}
      <ChannelItem
        channelKey="rgb"
        label="RGB"
        gradient="linear-gradient(135deg, #ef4444, #22c55e, #3b82f6)"
        visible={isComposite}
        isActive={isComposite}
        subtitle="composite"
        onToggleVisibility={handleShowAll}
        onSelect={handleShowAll}
      />

      {/* Individual channel rows */}
      {CHANNELS.map((ch) => {
        const isVisible = visibility[ch.key];
        // A channel is "active" (highlighted) when it's the ONLY one visible
        const visCount = (visibility.r ? 1 : 0) + (visibility.g ? 1 : 0) + (visibility.b ? 1 : 0) + (visibility.a ? 1 : 0);
        const isSolo = isVisible && visCount === 1;
        return (
          <ChannelItem
            key={ch.key}
            channelKey={ch.key}
            label={ch.label}
            color={ch.color}
            gradient={ch.gradient}
            visible={isVisible}
            isActive={isSolo}
            subtitle={ch.subtitle}
            onToggleVisibility={() => handleToggle(ch.key)}
            onSelect={() => handleSolo(ch.key)}
          />
        );
      })}
    </div>
  );
}
