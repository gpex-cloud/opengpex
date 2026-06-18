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

import * as P from "./protocols";
import type { LayerAdjustments } from "./protocols";

/**
 * ADJUSTMENT_COMMANDS: Declarative command configurations.
 */
export const ADJUSTMENT_COMMANDS = {
    update: {
        id: P.CMD_UPDATE,
        name: 'Update Adjustment',
        execute: (ctx: EditorContextValue, payload: { key: string; value: number }) => {
            const { activeFrame, activeLayer, actions } = ctx;
            if (!activeFrame || !activeLayer) return;

            const current = (activeLayer.adjustments || P.DEFAULT_ADJUSTMENTS) as LayerAdjustments;
            actions.updateLayer(activeFrame.id, activeLayer.id, {
                adjustments: {
                    ...current,
                    [payload.key]: payload.value
                }
            });
        }
    } as EditorCommand<{ key: string; value: number }, void>,
    beginEdit: {
        id: P.CMD_BEGIN_EDIT,
        name: 'Begin Adjustment Edit',
        undoable: true,
        execute: () => {}
    } as EditorCommand<void, void>,
    reset: {
        id: P.CMD_RESET,
        name: 'Reset Adjustments',
        undoable: true,
        execute: (ctx: EditorContextValue) => {
            const { activeFrame, activeLayer, actions } = ctx;
            if (!activeFrame || !activeLayer) return;

            actions.updateLayer(activeFrame.id, activeLayer.id, {
                adjustments: {
                    brightness: 100,
                    contrast: 100,
                    saturation: 100,
                    hueRotate: 0,
                    blur: 0
                }
            });
        },
        shortcuts: [{ key: '0', shift: true, alt: true }]
    } as EditorCommand<void, void>
};

