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
 * FILE_LOADER_COMMANDS: Declarative command configuration (Single Source of Truth).
 */
export const FILE_LOADER_COMMANDS = {
  import: {
    id: P.CMD_IMPORT,
    name: 'Import Files',
    execute: async (ctx: EditorContextValue, files: File[]) => {
      const { state, actions, files: fileService } = ctx;
      if (!state.isLoaded) return;

      const imageFiles = files.filter(f => fileService.detectFormat(f) !== 'unknown');

      for (const file of imageFiles) {
        const existingFrame = state.frames.order.map(id => state.frames.byId[id]).find(f => f.name === file.name);
        if (existingFrame) {
          const confirmed = await actions.askConfirm(
            "Creation Exists",
            `A creation named "${file.name}" already exists. Do you want to overwrite it?`
          );
          if (!confirmed) continue;
          ctx.layers.removeFrame(existingFrame.id);
        }

        // Standardized Frame Trunk Initialization Facade
        await actions.adv.frame.create.trunk.execute({ source: file });
      }
    }
  } as EditorCommand<File[]>,

  pick: {
    id: P.CMD_PICK,
    name: 'Open File Picker',
    shortcuts: [{ key: 'o', meta: true }],
    execute: () => {
      window.dispatchEvent(new CustomEvent('editor:trigger-file-picker'));
    }
  } as EditorCommand
};
