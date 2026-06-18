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

import { EditorPlugin } from '@opengpex/editor/core/types';
import { FileLoaderLandingAction, FileLoaderAction, FileLoaderComponent } from './components';
import { FILE_LOADER_COMMANDS } from './commands';
import * as P from './protocols';

/**
 * File Loader Plugin: Provides global file loading and project creation services.
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: 'File Loader',
    version: '1.0.0',
    description: 'Provides global file loading and project creation services.',
    category: 'overlays',
    author: P.PLUGIN_AUTHOR,
    requirements: {
      coreVersion: '>=1.0.0',
      auth: 'none'
    }
  },
  slot: 'ROOT_OVERLAY',
  component: FileLoaderComponent,
  order: 0,
  contributions: [
    {
      slot: 'TOOL_MENU',
      component: FileLoaderAction,
      order: 100
    },
    {
      slot: 'LANDING_PAGE',
      component: FileLoaderLandingAction,
      order: 0
    }
  ],
  commands: Object.values(FILE_LOADER_COMMANDS)
};

export default plugin;
