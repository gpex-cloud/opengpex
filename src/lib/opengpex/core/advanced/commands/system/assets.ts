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

import { EditorCommand, EditorContextValue } from '@opengpex/editor/core/types';
import * as P from '@opengpex/editor/core/advanced/protocols';

/**
 * SYSTEM_ASSET_COMMANDS: Responsible for conversion, synchronous orchestration of physical assets.
 *
 * NOTE (beta 52): `register` command removed — dead code with no external callers.
 * AssetService.register is called directly by importers/commands with required dimensions.
 */
export const SystemAssetCommands = {
  sync: {
    id: P.ADV_ASSET_SYNC,
    name: 'Synchronize Assets (GC)',
    execute: async (ctx: EditorContextValue, payload?: { force?: boolean }): Promise<void> => {
      const { state, storage } = ctx;

      // Trigger garbage collection to clean up unreferenced assets
      await storage.gc(state, payload?.force);
    }
  } as EditorCommand<{ force?: boolean } | undefined, Promise<void>>
};
