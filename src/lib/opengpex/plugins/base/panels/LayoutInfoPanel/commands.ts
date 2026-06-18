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

import { EditorContextValue, EditorCommand } from '@opengpex/editor/core/types';
import * as P from './protocols';

/**
 * LAYOUT_COMMANDS: Declarative command configurations (Single Source of Truth).
 */
export const LAYOUT_COMMANDS = {
  toggle: {
    id: P.CMD_TOGGLE,
    name: 'Toggle Layout Inspector',
    execute: (ctx: EditorContextValue) => {
      const { selfConfig, setSelfConfig } = ctx.scoped || {};
      const config = (selfConfig as P.LayoutConfig) || { enabled: false };
      setSelfConfig?.({ enabled: !config.enabled });
    },
    shortcut: { key: 'l', meta: true, shift: true }
  } as EditorCommand<void, void>,
};
