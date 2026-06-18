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
 * SYSTEM_ASSET_COMMANDS: Responsible for registration, conversion, and synchronous orchestration of physical assets.
 */
export const SystemAssetCommands = {
  register: {
    id: P.ADV_ASSET_REGISTER,
    name: 'Register Asset',
    execute: async (ctx: EditorContextValue, blob: Blob): Promise<{ id: string; url: string }> => {
      const { assets } = ctx;

      // 1. Call asset service for physical registration (based on SHA-256 hash)
      const id = await assets.register(blob);

      // 2. Get real-time ObjectURL
      const url = assets.getURL(id)!;

      return { id, url };
    }
  } as EditorCommand<Blob, Promise<{ id: string; url: string }>>,

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
