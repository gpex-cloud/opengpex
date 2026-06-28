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

import { EditorCommand, EditorContextValue } from '@opengpex/editor/core/types';
import { SettingsPanelAPI } from '../../panels/SettingsPanel/protocols';
import * as P from './protocols';

/**
 * TAB_DOCK_COMMANDS: Declarative command configurations (Single Source of Truth).
 */
export const TAB_DOCK_COMMANDS = {
  updateConfig: {
    id: P.CMD_UPDATE_CONFIG,
    name: 'Update Dock Config',
    execute: (ctx: EditorContextValue, patch: Partial<P.TabDockConfig>) => {
      const { setSelfConfig } = ctx.scoped || {};
      setSelfConfig?.(patch);
    }
  } as EditorCommand<Partial<P.TabDockConfig>, void>,

  nextFrame: {
    id: P.CMD_NEXT_FRAME,
    name: 'Next Creation',
    execute: (ctx: EditorContextValue) => {
      const { state, actions } = ctx;
      const { frames, activeFrameId } = state;
      if (frames.order.length <= 1) return;
      const currentIndex = frames.order.indexOf(activeFrameId || '');
      const nextIndex = (currentIndex + 1) % frames.order.length;
      actions.switchFrame(frames.order[nextIndex]);
    },
    shortcuts: [{ key: 'Tab', ctrl: true }, { key: 'ArrowRight', alt: true }]
  } as EditorCommand<void, void>,

  prevFrame: {
    id: P.CMD_PREV_FRAME,
    name: 'Previous Creation',
    execute: (ctx: EditorContextValue) => {
      const { state, actions } = ctx;
      const { frames, activeFrameId } = state;
      if (frames.order.length <= 1) return;
      const currentIndex = frames.order.indexOf(activeFrameId || '');
      const prevIndex = (currentIndex - 1 + frames.order.length) % frames.order.length;
      actions.switchFrame(frames.order[prevIndex]);
    },
    shortcuts: [{ key: 'Tab', ctrl: true, shift: true }, { key: 'ArrowLeft', alt: true }]
  } as EditorCommand<void, void>,

  openSettings: {
    id: P.CMD_OPEN_SETTINGS,
    name: 'Open Viewport Settings',
    execute: (ctx: EditorContextValue) => {
      // Cross-plugin call: uses fully qualified signal storage key exported by SettingsPanel
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.tab, 'Viewport');
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.open, true);
    },
  } as EditorCommand<void, void>,
};
