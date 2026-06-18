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

import {
  EditorContextValue,
  EditorCommand,
} from '@opengpex/editor/core/types';

import * as P from "./protocols";


/**
 * TIMETRAVEL_COMMANDS: Declarative command configurations
 * 
 * This is a pure "Command Shell".
 * 
 * All underlying algorithms for undo/redo (Immer Patch calculation, checkpoint difference reconciliation, camera viewport protection)
 * have been unified into the core state management layer (Core State / Reducer).
 * 
 * This plugin layer is only responsible for:
 * 1. Declaring shortcut bindings and command IDs
 * 2. Triggering core layer execution via high-level actions.history.undo/redo signals
 * 3. Integrating with the UI layer (exposing commands for UI buttons and panels to subscribe to)
 * 
 * If developers need to customize undo behavior, they only need to override the execute function of these commands.
 * The historical stack algorithm of the core engine will not be intruded by any external plugins.
 */
export const TIMETRAVEL_COMMANDS = {
  undo: {
    id: P.CMD_UNDO,
    name: 'Time Travel Undo',
    shortcut: { key: 'z', meta: true },
    execute: (ctx: EditorContextValue) => {
      ctx.actions.history.undo();
    }
  } as EditorCommand<void, void>,
  redo: {
    id: P.CMD_REDO,
    name: 'Time Travel Redo',
    shortcuts: [
      { key: 'z', meta: true, shift: true },
      { key: 'y', meta: true }
    ],
    execute: (ctx: EditorContextValue) => {
      ctx.actions.history.redo();
    }
  } as EditorCommand<void, void>,
  revert: {
    id: P.CMD_REVERT,
    name: 'Revert to Original',
    undoable: false,
    shortcut: { key: 'r', meta: true, shift: true },
    execute: async (ctx: EditorContextValue): Promise<void> => {
      // 💡 Protective guard: directly intercept shortcut keys/clicks under no artboard or LandingPage status, without popping up dialogs!
      if (!ctx.activeFrame) return;

      const confirmed = await ctx.actions.askConfirm(
        "Revert to Original",
        "This will reset all edits and restore the canvas to its original dimensions. Are you sure?",
        'danger',
        'rect'
      );
      if (confirmed) {
        ctx.actions.adv.frame.create.revert.execute();
      }
    }
  } as EditorCommand<void, Promise<void>>,
  purge: {
    id: P.CMD_PURGE,
    name: 'Clear All Time Streams',
    execute: (ctx: EditorContextValue) => {
      ctx.actions.history.purge();
    }
  } as EditorCommand<void, void>
};
