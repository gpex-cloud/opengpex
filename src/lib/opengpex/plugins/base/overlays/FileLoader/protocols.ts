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
 * FileOverlay Plugin Protocols
 */
export const PLUGIN_ID = 'overlays.file_loader';
export const PLUGIN_AUTHOR = 'opengpex';

/**
 * Commands (Actions)
 */
export const CMD_IMPORT = 'cmd.import';
export const CMD_PICK = 'cmd.pick';
/** Opens the New Document dialog (⌘N). */
export const CMD_NEW_BLANK = 'cmd.new_blank';
/** Creates the blank document from the dialog's parameters. */
export const CMD_CREATE_BLANK = 'cmd.create_blank';

/**
 * Signals (re-exported from core for local convenience)
 */
export { SIGNAL_IMPORTING } from '@opengpex/editor/core/advanced/commands/frame/importers';
export type { ImportingSignalValue } from '@opengpex/editor/core/advanced/commands/frame/importers';

/** Truthy while the New Document dialog is open (plugin-local UI state). */
export const SIGNAL_NEW_BLANK_MODAL = 'overlays.file_loader.new_blank_modal';

/**
 * Set by `cmd.create_blank` once the synthesized PNG has been imported; carries
 * `{ frameId, transparent }`. `FileLoaderComponent` finalizes the frame (placeholder
 * thumbnail, unlocked working layer for transparent canvases) from a React
 * effect, because a command's `ctx.state` is a call-time snapshot and cannot
 * observe the frame `adv.frame.trunk` just added.
 */
export const SIGNAL_NEW_BLANK_FINALIZE = 'overlays.file_loader.new_blank_finalize';

/** Object-literal type (not an interface) so it is assignable to `InteractionSignalValue`. */
export type NewBlankFinalizeSignal = {
  frameId: string;
  transparent: boolean;
};

/** Public path of the shared placeholder thumbnail every new blank document starts with. */
export const NEW_DOCUMENT_THUMBNAIL_URL = '/new-doc.webp';
