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
import { useEditorServices } from '@opengpex/editor/core/context';
import { CameraTransaction } from '@opengpex/editor/stage/interaction/CameraTransaction';

/**
 * useViewportCommands: Command Discovery Hook.
 * Returns AdvCommandRef object (named with Cmd suffix) and transactional camera operation helper tools.
 * Component layer explicitly calls commands via .execute().
 */
export const useViewportCommands = () => {
  const { actions } = useEditorServices();

  return useMemo(() => ({
    // Viewport Transform Commands (AdvCommandRef)
    rotateLeftCmd: actions.adv.viewport.transform.rotateLeft,
    rotateRightCmd: actions.adv.viewport.transform.rotateRight,
    flipHCmd: actions.adv.viewport.transform.flipH,
    flipVCmd: actions.adv.viewport.transform.flipV,
    resetTransformCmd: actions.adv.viewport.transform.reset,

    // Viewport Translate Commands (AdvCommandRef)
    fitCmd: actions.adv.viewport.translate.fit,
    actualSizeCmd: actions.adv.viewport.translate.actualSize,

    // Camera Transaction Factory (replaces deprecated fast.override/commit)
    createCameraTx: (frameId: string) => new CameraTransaction(actions, frameId),
  }), [actions]);
};
