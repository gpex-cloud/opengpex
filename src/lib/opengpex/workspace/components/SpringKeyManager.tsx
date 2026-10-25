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

import { useEffect } from 'react';
import { useEditorServices } from '@opengpex/editor/core/context';
import type { SpringChannel } from '@opengpex/editor/core/types';

/**
 * SpringKeyManager: keyboard state for the spring keys' DISPLAY half.
 *
 * The pointer ROUTING for Cmd+drag lives in the interaction dispatcher
 * (reads real-time modifiers off each pointer event) — this component owns
 * only the DISPLAY half: while Cmd/Ctrl is held, the viewport shows the
 * move cursor because the press will move the layer under the pointer.
 *
 * It only toggles the per-channel engagement INPUT: the cursor service
 * gives the meta channel top priority on every recompute, so while it is
 * held the resolved cursor is 'move' no matter what hover/tool/gesture
 * inputs assert, and the moment it releases the service falls back to
 * whatever those inputs say — no save/restore bookkeeping is needed here.
 *
 * It also mirrors the flag onto <html data-spring-meta>: the single global
 * CSS rule keyed on that attribute hides self-drawn pointer indicators
 * (brush/eraser/mosaic rings tagged `data-cursor-indicator`) while the key
 * is held — the display half of "the press routes away from this tool".
 */
export default function SpringKeyManager() {
  const { actions } = useEditorServices();

  useEffect(() => {
    // Channel registry: each row declares how its channel engages (a
    // keydown modifier test) and which key releases it. Adding a spring
    // channel (e.g. alt) is a new row here — the listeners below, the
    // per-channel volatile record and the <html data-spring-*> mirroring
    // are all generic. Only channels with semantics attached downstream
    // (dispatcher routing, cursor priority, indicator CSS) have an effect.
    const channels: Array<{
      channel: SpringChannel;
      engaged: (e: KeyboardEvent) => boolean;
      released: (key: string) => boolean;
    }> = [
      {
        channel: 'meta',
        // The Cmd/Ctrl logical key: Meta on macOS, Ctrl elsewhere. Pressing
        // the key alone engages (hover over a layer with Cmd held is
        // already a meaningful state), not only Cmd+letter.
        engaged: (e) => e.metaKey || e.ctrlKey,
        released: (key) => key === 'Meta' || key === 'Control',
      },
    ];

    const setDocFlag = (channel: SpringChannel, active: boolean) => {
      const attr = `spring${channel[0].toUpperCase()}${channel.slice(1)}`;
      if (active ? document.documentElement.dataset[attr] === 'true'
                 : document.documentElement.dataset[attr] === undefined) return;
      if (active) document.documentElement.dataset[attr] = 'true';
      else delete document.documentElement.dataset[attr];
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      let engagedAny = false;
      for (const row of channels) {
        if (!row.engaged(e)) continue;
        actions.fast.spring.setChannel(row.channel, true);
        setDocFlag(row.channel, true);
        engagedAny = true;
      }
      if (engagedAny) actions.fast.cursor.notifyContext();
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      let releasedAny = false;
      for (const row of channels) {
        if (!row.released(e.key)) continue;
        actions.fast.spring.setChannel(row.channel, false);
        setDocFlag(row.channel, false);
        releasedAny = true;
      }
      if (releasedAny) actions.fast.cursor.notifyContext();
    };

    const handleBlur = () => {
      // Safety net: keyup is NOT guaranteed to arrive (Cmd+Tab, Cmd+H and
      // friends hand focus to the OS mid-hold) — without this, the engaged
      // channels would stick until the next press of the same key.
      for (const row of channels) {
        actions.fast.spring.setChannel(row.channel, false);
        setDocFlag(row.channel, false);
      }
      actions.fast.cursor.notifyContext();
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [actions]);

  return null;
}
