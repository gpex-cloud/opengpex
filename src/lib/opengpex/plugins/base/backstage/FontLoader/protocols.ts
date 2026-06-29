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

/**
 * Plugin Identity
 */
export const PLUGIN_ID = 'backstage.font_loader';
export const PLUGIN_AUTHOR = 'opengpex';

/**
 * Commands
 */
export const CMD_LOAD_FONT = 'cmd.load_font';

/**
 * Signals
 */
export const SIGNAL_LOADING = 'signal.loading';

/**
 * FONT_LOADER_API: Public facade for other plugins to interact with FontLoader.
 *
 * Usage from other plugins:
 *   ctx.actions.executeCommand(FONT_LOADER_API.commands.loadFont.uid, { family: 'Roboto' });
 *   ctx.getSignal(FONT_LOADER_API.signals.loading); // boolean
 */
export const FONT_LOADER_API = {
  signals: {
    loading: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_LOADING}` as const,
  },
  commands: {
    loadFont: {
      uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_LOAD_FONT}`,
    } as { uid: string; _payload: { family: string } },
  },
} as const;
