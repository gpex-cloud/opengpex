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

import { EditorCommand, EditorContextValue } from '@opengpex/editor/core/types';
import { writeFrameDraft, getFrameDraftCodec } from '@opengpex/editor/core/state/drafts';
import * as P from '@opengpex/editor/core/advanced/protocols';

/**
 * cmd.frame.set_draft — THE system-level write channel for Frame.drafts.
 *
 * Replaces the payload a tool keeps on `frame.drafts[toolId]` (null clears
 * the entry). Undoable, so one finished gesture = one history step — the
 * pre-execution SIGNAL_COMMIT checkpoint that `executeCommand` establishes
 * is what makes the gesture diffable. Tools must route their finished
 * working copies through THIS command (never a bare `updateFrame`), which
 * guarantees the write passes the codec whitelist before it can touch
 * document state.
 */
export const FrameDraftCommands = {
  setDraft: {
    id: P.ADV_FRAME_SET_DRAFT,
    name: 'Set Frame Draft',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { frameId: string; toolId: string; payload: unknown }): void => {
      const frame = ctx.state.frames.byId[payload.frameId];
      if (!frame) return;
      // Same whitelist discipline as document hydration: a write for a tool
      // without a registered codec (or with a payload failing validation)
      // never reaches document state.
      const codec = getFrameDraftCodec(payload.toolId);
      if (!codec) return;
      if (payload.payload !== null && payload.payload !== undefined && !codec.validate(payload.payload)) return;
      ctx.actions.updateFrame(payload.frameId, writeFrameDraft(frame, payload.toolId, payload.payload ?? null));
    },
  },
} satisfies Record<string, EditorCommand<{ frameId: string; toolId: string; payload: unknown }, void>>;
