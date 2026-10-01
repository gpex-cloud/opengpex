/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

'use client';

import { EditorCommand, EditorContextValue } from '@opengpex/editor/core/types';
import * as P from '@opengpex/editor/core/advanced/protocols';

export const FrameRemoveCommand = {
  id: P.ADV_FRAME_REMOVE,
  name: 'Delete Creation',
  execute: async (ctx: EditorContextValue, id?: string): Promise<void> => {
    const { actions, state } = ctx;
    const targetId = id || state.activeFrameId;
    if (!targetId) return;

    const frame = state.frames.byId[targetId];
    if (!frame) return;

    const confirmed = await actions.askConfirm(
      `Delete "${frame.name}"?`,
      "This action is permanent and cannot be undone. All associated history and assets will be purged.",
      'danger',
      'rect',
    );

    if (confirmed) {
      requestAnimationFrame(() => {
        ctx.layers.removeFrame(targetId);
        actions.setInteraction({ hud: { message: 'Creation deleted permanently.', type: 'success' } });
      });
    }
  },
} as EditorCommand<string | undefined, Promise<void>>;

export const FrameRemoveCommands = {
  remove: FrameRemoveCommand,
};
