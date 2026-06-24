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

import { EditorContextValue, EditorCommand, BuiltCommand } from '@opengpex/editor/core/types';
import { FrameCreateCommands } from './commands/frame/create';
import { FrameResizeCommands } from './commands/frame/resize';
import { LayerToggleCommands } from './commands/layer/toggle';
import { LayerMergeCommands } from './commands/layer/merge';
import { SystemEngineCommands } from './commands/system/engines';
import { LayerClipCommands } from './commands/layer/clip';
import { LayerCmdJCommands } from './commands/layer/cmdj';
import { LayerPeelCommands } from './commands/layer/peel';
import { LayerMaskCommands } from './commands/layer/vmask';
import { LayerBitmapMaskCommands } from './commands/layer/bmask';
import { ViewportTranslateCommands } from './commands/viewport/translate';
import { SystemAssetCommands } from './commands/system/assets';
import { ViewportTransformCommands } from './commands/viewport/transform';

/**
 * Advanced command protocol definitions
 */
export * from './protocols';

/**
 * Export advanced command sets
 */
export * from './commands/frame/create';
export * from './commands/frame/resize';
export * from './commands/layer/toggle';
export * from './commands/layer/merge';
export * from './commands/system/engines';
export * from './commands/layer/clip';
export * from './commands/layer/cmdj';
export * from './commands/layer/peel';
export * from './commands/layer/vmask';
export * from './commands/layer/bmask';
export * from './commands/viewport/translate';
export * from './commands/system/assets';
export * from './commands/viewport/transform';

/**
 * Register all built-in advanced commands to the command bus
 */
export function registerAdvancedCommands(ctx: EditorContextValue['actions']) {
  const allCommandSets = [
    FrameCreateCommands,
    FrameResizeCommands,
    LayerToggleCommands,
    LayerMergeCommands,
    SystemEngineCommands,
    LayerClipCommands,
    LayerCmdJCommands,
    LayerPeelCommands,
    LayerMaskCommands,
    LayerBitmapMaskCommands,
    ViewportTranslateCommands,
    SystemAssetCommands,
    ViewportTransformCommands,
  ];

  allCommandSets.forEach(cmdSet => {
    Object.values(cmdSet).forEach((command: EditorCommand) => {
      const builtCommand: BuiltCommand = {
        ...command,
        uid: command.id
      };
      // 1. Register execution logic
      ctx.registerCommand(builtCommand);

      // 2. Bridge shortcut registration (maintain atomic separation, manually map shortcuts)
      const shortcuts = command.shortcuts || (command.shortcut ? [command.shortcut] : []);
      shortcuts.forEach((sc, index) => {
        ctx.registerShortcut({
          id: shortcuts.length > 1 ? `${command.id}-${index}` : command.id,
          name: command.name,
          category: 'General',
          ...sc,
          action: () => ctx.executeCommand(command.id),
          description: command.name
        });
      });
    });
  });
}
