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
import { getDynamicTextSizeMax } from './protocols';
import type { CraftType, CraftDrawerConfig } from './protocols';
import {
  TextOverlayAPI,
} from '../../overlays/TextOverlay/protocols';

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
      adjustCraftSize(ctx, 1);
    },
    shortcuts: [{ key: ']', shift: true }, { key: '}', shift: true }],
  } as EditorCommand<void, void>,

  brushSizeDown: {
    id: P.CMD_BRUSH_SIZE_DOWN,
    name: 'Decrease Brush Size',
    execute: (ctx: EditorContextValue) => {
      adjustCraftSize(ctx, -1);
    },
    shortcuts: [{ key: '[', shift: true }, { key: '{', shift: true }],
  } as EditorCommand<void, void>,



  brushOpacityUp: {
    id: P.CMD_BRUSH_OPACITY_UP,
    name: 'Increase Brush Opacity',
    execute: (ctx: EditorContextValue) => {
      adjustBrushOpacity(ctx, 10);
    },
    // shortcuts: [
    //   { key: ']', shift: true, meta: true },
    //   { key: '}', shift: true, meta: true }
    // ]
  } as EditorCommand<void, void>,

  brushOpacityDown: {
    id: P.CMD_BRUSH_OPACITY_DOWN,
    name: 'Decrease Brush Opacity',
    execute: (ctx: EditorContextValue) => {
      adjustBrushOpacity(ctx, -10);
    },
    // shortcuts: [
    //   { key: '[', shift: true, meta: true },
    //   { key: '{', shift: true, meta: true }
    // ]
  } as EditorCommand<void, void>,

  brushHardnessUp: {
    id: P.CMD_BRUSH_HARDNESS_UP,
    name: 'Increase Brush Hardness',
    execute: (ctx: EditorContextValue) => {
      adjustBrushHardness(ctx, 10);
    },
    // shortcuts: [
    //   { key: ']', alt: true, meta: true }
    // ]
  } as EditorCommand<void, void>,

  brushHardnessDown: {
    id: P.CMD_BRUSH_HARDNESS_DOWN,
    name: 'Decrease Brush Hardness',
    execute: (ctx: EditorContextValue) => {
      adjustBrushHardness(ctx, -10);
    },
    // shortcuts: [
    //   { key: '[', alt: true, meta: true }
    // ]
  } as EditorCommand<void, void>,
};

// ─── Brush/Text Shortcut Helpers ───────────────────────────────────────────────

function adjustCraftSize(ctx: EditorContextValue, direction: 1 | -1) {
  const craft = ctx.scoped!.getSignal<P.ActiveCraft>(P.SIGNAL_ACTIVE_CRAFT, null);
  const frameId = ctx.state.activeFrameId;
  const activeFrame = frameId ? ctx.state.frames.byId[frameId] : null;
  const activeLayer = activeFrame?.activeLayerId ? activeFrame.layers.byId[activeFrame.activeLayerId] : null;

  // Support adjusting text size with same hotkeys when in text tool or when a text layer is selected
  if (craft === 'text' || (craft === null && activeLayer?.type === 'text')) {
    if (activeLayer && activeLayer.type === 'text' && activeLayer.textData) {
      const currentSize = activeLayer.textData.fontSize || 24;
      // Dynamic step: finer control at small sizes, coarser at large sizes
      const step = currentSize < 50 ? 1 : currentSize < 200 ? 2 : 4;
      const targetSize = currentSize + step * direction;
      // Dynamic max based on canvas dimensions
      const dynamicMax = getDynamicTextSizeMax(activeFrame?.canvas.w, activeFrame?.canvas.h);
      const newSize = Math.max(6, Math.min(dynamicMax, targetSize));

      const editingLayerId = ctx.state.interaction.signals[TextOverlayAPI.signals.editingTextLayerId] as string | null;
      if (editingLayerId) {
        ctx.actions.updateLayer(frameId!, activeLayer.id, {
          textData: { ...activeLayer.textData, fontSize: newSize },
        });
      } else {
        ctx.actions.executeCommand(TextOverlayAPI.commands.updateProperties.uid, {
          frameId: frameId!,
          layerId: activeLayer.id,
          patch: { fontSize: newSize },
        });
      }
      ctx.actions.notifyHUD(`Text Size: ${newSize}px`, 'info');
    }
    return;
  }

  // Only responds in brush/eraser mode
  if (craft !== 'brush' && craft !== 'eraser') return;

  const config = ctx.scoped!.selfConfig as CraftDrawerConfig;
  const currentSize = config.brushSize || 12;

  // Round to nearest multiple of 5 first, then adjust by 5
  const rounded = Math.round(currentSize / 5) * 5;
  const targetSize = rounded + 5 * direction;

  const newSize = Math.max(1, Math.min(500, targetSize));
  ctx.scoped!.setSelfConfig({ brushSize: newSize });

  // HUD feedback
  ctx.actions.notifyHUD(`Size: ${newSize}px`, 'info');
}



function adjustBrushOpacity(ctx: EditorContextValue, delta: number) {
  const craft = ctx.scoped!.getSignal<P.ActiveCraft>(P.SIGNAL_ACTIVE_CRAFT, null);
  if (craft !== 'brush' && craft !== 'eraser') return;

  const config = ctx.scoped!.selfConfig as CraftDrawerConfig;
  const currentOpacity = config.brushOpacity ?? 100;
  const newOpacity = Math.max(10, Math.min(100, currentOpacity + delta));

  ctx.scoped!.setSelfConfig({ brushOpacity: newOpacity });

  // HUD feedback
  ctx.actions.notifyHUD(`Opacity: ${newOpacity}%`, 'info');
}

function adjustBrushHardness(ctx: EditorContextValue, delta: number) {
  const craft = ctx.scoped!.getSignal<P.ActiveCraft>(P.SIGNAL_ACTIVE_CRAFT, null);
  if (craft !== 'brush' && craft !== 'eraser') return;

  const config = ctx.scoped!.selfConfig as CraftDrawerConfig;
  const currentHardness = config.brushHardness ?? 80;
  const newHardness = Math.max(0, Math.min(100, currentHardness + delta));

  ctx.scoped!.setSelfConfig({ brushHardness: newHardness });

  // HUD feedback
  ctx.actions.notifyHUD(`Hardness: ${newHardness}%`, 'info');
}
