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

/**
 * Revert Command — Thin dispatch shell.
 *
 * Routes to the appropriate revert strategy:
 * - GIF frames → revertGifFrame (multi-layer rebuild with frame count dialog)
 * - Standard frames → revertFrame (single-layer rebuild from original blob)
 *
 * All heavy lifting is in `importers/index.ts`.
 */

'use client';

import { EditorCommand, EditorContextValue } from '@opengpex/editor/core/types';
import * as P from '@opengpex/editor/core/advanced/protocols';
import { revertFrame, revertGifFrame } from './importers';

export const FrameRevertCommand = {
  id: P.ADV_FRAME_REVERT,
  name: 'Revert to Original',
  undoable: false,
  execute: async (ctx: EditorContextValue): Promise<void> => {
    const { activeFrame } = ctx;
    if (!activeFrame) return;

    // Route: GIF (has originalGifAssetId in extra) vs standard
    const isGif = !!(activeFrame.extra as Record<string, unknown>)?.originalGifAssetId;

    if (isGif) {
      await revertGifFrame(ctx, activeFrame.id);
    } else {
      await revertFrame(ctx, activeFrame.id);
    }
  },
} as EditorCommand<void, Promise<void>>;

export const FrameRevertCommands = {
  revert: FrameRevertCommand,
};
