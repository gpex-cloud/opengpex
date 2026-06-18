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
 * SYSTEM_ENGINE_COMMANDS: Handles editor runtime probing and environment initialization.
 */
export const SystemEngineCommands = {
  probeEngines: {
    id: P.ADV_SYSTEM_PROBE_ENGINES,
    name: 'Probe Interaction Engines',
    execute: (ctx: EditorContextValue): void => {
      const statuses = ctx.pixels.utils.probeEngines();
      ctx.actions.setEngineStatus(statuses);
      console.log('[SystemEngineCommands] Engines probed and state updated:', statuses);
    }
  } as EditorCommand<void, void>
};
