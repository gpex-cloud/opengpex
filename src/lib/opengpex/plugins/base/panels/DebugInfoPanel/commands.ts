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

import { EditorContextValue, EditorCommand } from '@opengpex/editor/core/types';
import * as P from './protocols';

/**
 * DEBUG_COMMANDS: Declarative command configurations (Single Source of Truth).
 */
export const DEBUG_COMMANDS = {
  toggle: {
    id: P.CMD_TOGGLE,
    name: 'Toggle Debug Info',
    execute: (ctx: EditorContextValue) => {
      const { selfConfig, setSelfConfig } = ctx.scoped || {};
      const current = (selfConfig as P.DebugConfig)?.enabled ?? false;
      setSelfConfig?.({ enabled: !current });
    },
    shortcut: { key: 'd', meta: true, shift: true }
  } as EditorCommand<void, void>
};
