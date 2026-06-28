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

import { useMemo } from 'react';
import { usePluginCommands } from '@opengpex/editor/core/context';
import type { AdjustmentCommandsMap } from './commands.d';

/**
 * useAdjustmentCommands: Command Discovery Hook.
 * Transparently passes Cmd references, component layer calls .execute() explicitly.
 */
export const useAdjustmentCommands = () => {
    const { updateCmd, beginEditCmd, resetCmd } = usePluginCommands<AdjustmentCommandsMap>();

    return useMemo(() => ({
        // Plugin Commands (Transparently passed Cmd references)
        updateCmd,
        resetCmd,

        // Undo checkpoint: triggers SIGNAL_COMMIT via undoable command
        commit: () => beginEditCmd?.execute()
    }), [updateCmd, beginEditCmd, resetCmd]);
};
