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
import { detectFormat } from '@opengpex/editor/core/files';
import * as P from './protocols';

/**
 * FILE_LOADER_COMMANDS: Declarative command configuration (Single Source of Truth).
 */
export const FILE_LOADER_COMMANDS = {
  import: {
    id: P.CMD_IMPORT,
    name: 'Import Files',
    execute: async (ctx: EditorContextValue, files: File[]) => {
      const { state, actions } = ctx;
      if (!state.isLoaded) return;

      const imageFiles = files.filter(f => detectFormat(f) !== 'unknown');
      if (imageFiles.length === 0) return;

      try {
        for (let i = 0; i < imageFiles.length; i++) {
          const file = imageFiles[i];

          // Set importing progress (HUD always shows "Loading…" or "Loading 2/5…")
          actions.setStateSignal(P.SIGNAL_IMPORTING, { current: i + 1, total: imageFiles.length });

          // Match by frame.source (original filename with extension, set at import time)
          const existingFrame = state.frames.order.map(id => state.frames.byId[id]).find(f => f.source === file.name);
          if (existingFrame) {
            const choice = await actions.askChoice("Creation Exists", [
              { id: 'overwrite', label: 'Overwrite', description: 'Replace the existing creation', primary: true },
              { id: 'new', label: 'New Import', description: 'Keep both as separate creations' },
              { id: 'cancel', label: 'Never Mind', description: 'Skip this file' },
            ], `A creation from "${file.name}" already exists.`);

            if (!choice || choice === 'cancel') continue; // Cancel → skip this file
            if (choice === 'overwrite') {
              ctx.layers.removeFrame(existingFrame.id);
            }
            // 'new' → fall through to import as a new frame
          }

          // Standardized Frame Trunk Initialization Facade
          await actions.adv.frame.create.trunk.execute({ source: file });
        }
      } finally {
        // Always clear the signal, even on error
        actions.setStateSignal(P.SIGNAL_IMPORTING, null);
      }
    }
  } as EditorCommand<File[]>,

  pick: {
    id: P.CMD_PICK,
    name: 'Open File Picker',
    category: 'File',
    shortcuts: [{ key: 'o', meta: true }],
    execute: () => {
      window.dispatchEvent(new CustomEvent('editor:trigger-file-picker'));
    }
  } as EditorCommand
};
