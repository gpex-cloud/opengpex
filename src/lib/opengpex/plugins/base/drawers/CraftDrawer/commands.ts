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

import { EditorContextValue, EditorCommand } from '@opengpex/editor/core/types';
import * as P from './protocols';
import type { CraftType, CraftDrawerConfig } from './protocols';

// ─── Shared Logic ──────────────────────────────────────────────────────────────

function activateCraft(ctx: EditorContextValue, craft: CraftType) {
  const current = ctx.scoped!.getSignal<P.ActiveCraft>(P.SIGNAL_ACTIVE_CRAFT, null);

  // Toggle: If current tool matches target, deactivate
  if (current === craft) {
    ctx.scoped!.setSignal(P.SIGNAL_ACTIVE_CRAFT, null);
    ctx.actions.setInteraction({ interactionMode: 'pan' });
    return;
  }

  // Activate target tool
  ctx.scoped!.setSignal(P.SIGNAL_ACTIVE_CRAFT, craft);
  ctx.actions.setInteraction({ interactionMode: 'craft' });
}

function deactivate(ctx: EditorContextValue) {
  ctx.scoped!.setSignal(P.SIGNAL_ACTIVE_CRAFT, null);
  ctx.actions.setInteraction({ interactionMode: 'pan' });
}

// ─── Commands ──────────────────────────────────────────────────────────────────

/**
 * CRAFT_COMMANDS: Craft tool commands
 *
 * - setCraft: Generic activation command (called by button clicks, passing payload)
 * - setCraftText / setCraftBrush / setCraftEraser: Independent commands with shortcuts (T/B/E)
 * - deactivateCraft: Deactivate current tool (V)
 */
export const CRAFT_COMMANDS = {
  setCraft: {
    id: P.CMD_SET_CRAFT,
    name: 'Activate Craft Tool',
    execute: (ctx: EditorContextValue, payload: { craft: CraftType }) => {
      activateCraft(ctx, payload.craft);
    },
  } as EditorCommand<{ craft: CraftType }, void>,

  setCraftText: {
    id: P.CMD_SET_CRAFT_TEXT,
    name: 'Text Tool',
    execute: (ctx: EditorContextValue) => {
      activateCraft(ctx, 'text');
    },
    shortcut: { key: 't' },
  } as EditorCommand<void, void>,

  setCraftBrush: {
    id: P.CMD_SET_CRAFT_BRUSH,
    name: 'Brush Tool',
    execute: (ctx: EditorContextValue) => {
      activateCraft(ctx, 'brush');
    },
    shortcut: { key: 'b' },
  } as EditorCommand<void, void>,

  setCraftEraser: {
    id: P.CMD_SET_CRAFT_ERASER,
    name: 'Eraser Tool',
    execute: (ctx: EditorContextValue) => {
      activateCraft(ctx, 'eraser');
    },
    shortcut: { key: 'e' },
  } as EditorCommand<void, void>,

  deactivateCraft: {
    id: P.CMD_DEACTIVATE_CRAFT,
    name: 'Deactivate Craft Tool',
    execute: (ctx: EditorContextValue) => {
      deactivate(ctx);
    },
    shortcut: { key: 'v' },
  } as EditorCommand<void, void>,

  // ─── Brush Parameter Shortcuts ─────────────────────────────────────────────

  brushSizeUp: {
    id: P.CMD_BRUSH_SIZE_UP,
    name: 'Increase Brush Size',
    execute: (ctx: EditorContextValue) => {
      adjustBrushSize(ctx, 1);
    },
    shortcut: { key: ']', shift: true },
  } as EditorCommand<void, void>,

  brushSizeDown: {
    id: P.CMD_BRUSH_SIZE_DOWN,
    name: 'Decrease Brush Size',
    execute: (ctx: EditorContextValue) => {
      adjustBrushSize(ctx, -1);
    },
    shortcut: { key: '[', shift: true },
  } as EditorCommand<void, void>,

  brushOpacity1: {
    id: P.CMD_BRUSH_OPACITY_1,
    name: 'Brush Opacity 10%',
    execute: (ctx: EditorContextValue) => { setBrushOpacity(ctx, 10); },
    shortcut: { key: '1' },
  } as EditorCommand<void, void>,

  brushOpacity2: {
    id: P.CMD_BRUSH_OPACITY_2,
    name: 'Brush Opacity 20%',
    execute: (ctx: EditorContextValue) => { setBrushOpacity(ctx, 20); },
    shortcut: { key: '2' },
  } as EditorCommand<void, void>,

  brushOpacity3: {
    id: P.CMD_BRUSH_OPACITY_3,
    name: 'Brush Opacity 30%',
    execute: (ctx: EditorContextValue) => { setBrushOpacity(ctx, 30); },
    shortcut: { key: '3' },
  } as EditorCommand<void, void>,

  brushOpacity4: {
    id: P.CMD_BRUSH_OPACITY_4,
    name: 'Brush Opacity 40%',
    execute: (ctx: EditorContextValue) => { setBrushOpacity(ctx, 40); },
    shortcut: { key: '4' },
  } as EditorCommand<void, void>,

  brushOpacity5: {
    id: P.CMD_BRUSH_OPACITY_5,
    name: 'Brush Opacity 50%',
    execute: (ctx: EditorContextValue) => { setBrushOpacity(ctx, 50); },
    shortcut: { key: '5' },
  } as EditorCommand<void, void>,

  brushOpacity6: {
    id: P.CMD_BRUSH_OPACITY_6,
    name: 'Brush Opacity 60%',
    execute: (ctx: EditorContextValue) => { setBrushOpacity(ctx, 60); },
    shortcut: { key: '6' },
  } as EditorCommand<void, void>,

  brushOpacity7: {
    id: P.CMD_BRUSH_OPACITY_7,
    name: 'Brush Opacity 70%',
    execute: (ctx: EditorContextValue) => { setBrushOpacity(ctx, 70); },
    shortcut: { key: '7' },
  } as EditorCommand<void, void>,

  brushOpacity8: {
    id: P.CMD_BRUSH_OPACITY_8,
    name: 'Brush Opacity 80%',
    execute: (ctx: EditorContextValue) => { setBrushOpacity(ctx, 80); },
    shortcut: { key: '8' },
  } as EditorCommand<void, void>,

  brushOpacity9: {
    id: P.CMD_BRUSH_OPACITY_9,
    name: 'Brush Opacity 90%',
    execute: (ctx: EditorContextValue) => { setBrushOpacity(ctx, 90); },
    shortcut: { key: '9' },
  } as EditorCommand<void, void>,

  brushOpacity0: {
    id: P.CMD_BRUSH_OPACITY_0,
    name: 'Brush Opacity 100%',
    execute: (ctx: EditorContextValue) => { setBrushOpacity(ctx, 100); },
    shortcut: { key: '0' },
  } as EditorCommand<void, void>,
};

// ─── Brush Shortcut Helpers ────────────────────────────────────────────────────

const BRUSH_SIZE_STEP_TABLE = [
  { max: 10, step: 1 },
  { max: 50, step: 5 },
  { max: 100, step: 10 },
  { max: 200, step: 20 },
  { max: 500, step: 50 },
];

function adjustBrushSize(ctx: EditorContextValue, direction: 1 | -1) {
  // Only responds in brush/eraser mode
  const craft = ctx.scoped!.getSignal<P.ActiveCraft>(P.SIGNAL_ACTIVE_CRAFT, null);
  if (craft !== 'brush' && craft !== 'eraser') return;

  const config = ctx.scoped!.selfConfig as CraftDrawerConfig;
  const currentSize = config.brushSize || 12;

  // Determine step size based on current size
  let step = 50;
  for (const entry of BRUSH_SIZE_STEP_TABLE) {
    if (currentSize <= entry.max) { step = entry.step; break; }
  }

  const newSize = Math.max(1, Math.min(500, currentSize + step * direction));
  ctx.scoped!.setSelfConfig({ brushSize: newSize });

  // HUD feedback
  ctx.actions.setInteraction({
    hud: { message: `Size: ${newSize}px`, type: 'info' },
  });
}

function setBrushOpacity(ctx: EditorContextValue, opacity: number) {
  // Only responds in brush/eraser mode
  const craft = ctx.scoped!.getSignal<P.ActiveCraft>(P.SIGNAL_ACTIVE_CRAFT, null);
  if (craft !== 'brush' && craft !== 'eraser') return;

  ctx.scoped!.setSelfConfig({ brushOpacity: opacity });

  // HUD feedback
  ctx.actions.setInteraction({
    hud: { message: `Opacity: ${opacity}%`, type: 'info' },
  });
}
