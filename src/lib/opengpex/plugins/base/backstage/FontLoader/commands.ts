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

import * as P from './protocols';

/**
 * FONT_LOADER_COMMANDS: Declarative command configurations for font loading.
 *
 * This plugin provides a single command `cmd.load_font` that:
 * 1. Sets the loading signal to true (UI can show a spinner)
 * 2. Delegates to ctx.fonts.load(family) for actual font loading
 * 3. Clears the loading signal on completion
 *
 * Other plugins (e.g., CraftDrawer text panel) trigger this command
 * when the user selects a new font family.
 */
export const FONT_LOADER_COMMANDS = {
  loadFont: {
    id: P.CMD_LOAD_FONT,
    name: 'Load Font',
    execute: async (ctx: EditorContextValue, payload?: { family: string }): Promise<boolean> => {
      if (!payload?.family) return false;

      const { family } = payload;

      // Skip if already loaded
      if (ctx.fonts.isLoaded(family)) return true;

      // Set loading signal for UI feedback
      ctx.actions.setStateSignal(P.FONT_LOADER_API.signals.loading, true);

      try {
        const success = await ctx.fonts.load(family);
        return success;
      } catch (e) {
        console.error(`[FontLoader] Failed to load font: ${family}`, e);
        return false;
      } finally {
        ctx.actions.setStateSignal(P.FONT_LOADER_API.signals.loading, false);
      }
    },
  } as EditorCommand<{ family: string }, Promise<boolean>>,
};
