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

import { InteractionHandler, Layer, Frame, LocalRect, asLocalShape, asWorldRect } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { InteractionTransaction } from '@opengpex/editor/stage/interaction/Transaction';
import { createTransformHandler } from '@opengpex/editor/stage/interaction/handlers/TransformHandler';
import { CraftDrawerAPI } from '../../drawers/CraftDrawer/protocols';
import type { PendingTextData } from '../../drawers/CraftDrawer/protocols';
import { TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID, _CMD_PLACE_UID, _CMD_EDIT_START_UID } from './protocols';
import { ColorOptionsAPI } from '../../options/ColorOptions/protocols';

/** Shared signal keys (cross-plugin constants) */
const ACTIVE_CRAFT_KEY = CraftDrawerAPI.signals.activeCraft;
const EDITING_TEXT_KEY = TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID;

/** Command UIDs (from protocols, Single Source of Truth) */
const CMD_PLACE_UID = _CMD_PLACE_UID;
const CMD_EDIT_START_UID = _CMD_EDIT_START_UID;

/**
 * Finds hit layer of type 'text' in canvas-local coordinates
 * Returns the first hit visible text layer, detecting from top to bottom in layer order
 */
function findTextLayerAtPoint(frame: Frame, point: { x: number; y: number }): Layer | null {
  const canvas = frame.canvas;
  // Traverse from top layer to bottom layer (end of order = top layer)
  for (let i = frame.layers.order.length - 1; i >= 0; i--) {
    const layer = frame.layers.byId[frame.layers.order[i]];
    if (!layer || layer.type !== 'text' || !layer.visible) continue;

    // Position of top-left corner of layer in canvas coordinate system
    const layerLeft = canvas.w / 2 + layer.cx - layer.bounding.w / 2;
    const layerTop = canvas.h / 2 + layer.cy - layer.bounding.h / 2;
    const layerRight = layerLeft + layer.bounding.w;
    const layerBottom = layerTop + layer.bounding.h;

    if (
      point.x >= layerLeft &&
      point.x <= layerRight &&
      point.y >= layerTop &&
      point.y <= layerBottom
    ) {
      return layer;
    }
  }
  return null;
}

// ─── TextMoveHandler ───────────────────────────────────────────────────────────

/**
 * TextMoveHandler: Cmd/Ctrl + drag to move text layer
 *
 * In text craft mode (regardless of entering editing state), hold Meta/Ctrl key
 * and drag an existing text layer to move its position.
 *
 * Design considerations:
 * - Does not trigger entering/exiting editing state
 * - Cursor position remains after moving in editing state (only changes cx/cy)
 * - Uses InteractionTransaction to guarantee undo support
 */
export const createTextMoveHandler = (): InteractionHandler => {
  let startCanvas = { x: 0, y: 0 };
  let startLayerPos = { x: 0, y: 0 };
  let targetLayerId: string | null = null;
  let tx: InteractionTransaction | null = null;

  return {
    id: 'text-move',
    priority: 170, // Highest priority (intercept first when Cmd is pressed)

    test: (e) => {
      // Must be in craft mode and activeCraft === 'text'
      if (e.state.interaction.interactionMode !== 'craft') return false;
      if (e.state.interaction.signals[ACTIVE_CRAFT_KEY] !== 'text') return false;

      // Must hold Cmd/Ctrl
      const mouseEvent = e.nativeEvent as MouseEvent;
      if (!mouseEvent.metaKey && !mouseEvent.ctrlKey) return false;

      // Exclude UI elements
      const target = mouseEvent.target as HTMLElement;
      if (target.closest('button, a, input, [data-role="ui"]')) return false;

      // Case 1: Layer being edited -> use as target directly
      const editingId = e.state.interaction.signals[EDITING_TEXT_KEY] as string | null;
      if (editingId) {
        targetLayerId = editingId;
        return true;
      }

      // Case 2: Pre-editing state -> find text layer via hit detection
      const hitLayer = findTextLayerAtPoint(e.activeFrame, e.point.canvas);
      if (hitLayer) {
        targetLayerId = hitLayer.id;
        return true;
      }

      return false;
    },

    onStart: (e) => {
      if (!targetLayerId) return;
      const frame = e.activeFrame;
      const layer = frame.layers.byId[targetLayerId];
      if (!layer) return;

      startCanvas = { x: e.point.canvas.x, y: e.point.canvas.y };
      startLayerPos = { x: layer.cx, y: layer.cy };

      tx = new InteractionTransaction(e);
      const editingId = e.state.interaction.signals[EDITING_TEXT_KEY] as string | null;
      // If the target layer is currently being edited, run silently to avoid creating
      // intermediate undo checkpoints with unrasterized (empty assetId/src) temporary state.
      const isSilent = !!(editingId && targetLayerId === editingId);
      tx.begin(isSilent);

      // Set grabbing onStart
      e.actions.setInteraction({ cursorOverride: 'grabbing' });
    },

    onMove: (e) => {
      if (!targetLayerId || !tx) return;

      const dx = e.point.canvas.x - startCanvas.x;
      const dy = e.point.canvas.y - startCanvas.y;

      const newCx = startLayerPos.x + dx;
      const newCy = startLayerPos.y + dy;

      tx.update({ cx: newCx, cy: newCy }, 'layer', targetLayerId);
    },

    onEnd: (e) => {
      if (tx) {
        tx.commit();
        tx = null;
      }
      targetLayerId = null;

      // If still holding Cmd/Ctrl when drag ends, restore to grab, otherwise reset to null
      const stillHoldingCmd = e.keys.meta;
      e.actions.setInteraction({
        cursorOverride: stillHoldingCmd ? 'grab' : null,
      });
    },
  };
};

// ─── TextResizeHandler ─────────────────────────────────────────────────────────

/**
 * TextResizeHandler: Editing state text box scaling interaction handler
 *
 * Only active in editing state, identifying drag direction via data-handle attribute,
 * using createTransformHandler factory to implement standard 8-direction scaling.
 * Automatically switches to fixed boxMode after dragging.
 */
export const createTextResizeHandler = (): InteractionHandler => {
  return createTransformHandler({
    id: 'text-resize',
    priority: 160,
    // Always run silently because resize handle drags only occur in active text editing mode.
    // This prevents checkpointing unrasterized (empty assetId/src) temporary states in the history stack.
    silent: true,

    test: (e) => {
      // Must be in craft mode to resize text layer
      if (e.state.interaction.interactionMode !== 'craft') return null;

      // Must have a text layer currently being edited
      const editingId = e.state.interaction.signals[EDITING_TEXT_KEY] as string | null;
      if (!editingId) return null;

      // Only responds to resize handle clicks
      const target = e.nativeEvent.target as HTMLElement;
      const handleEl = target.closest('[data-handle]') as HTMLElement;
      if (!handleEl) return null;

      const handleType = handleEl.dataset.handle;
      // Exclude 'move' (clicks inside text box are handled by contenteditable)
      if (!handleType || handleType === 'move') return null;

      return handleType; // 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w'
    },

    getInitialState: (e) => {
      const editingId = e.state.interaction.signals[EDITING_TEXT_KEY] as string;
      const frame = e.activeFrame;
      const layer = frame.layers.byId[editingId];
      const canvas = frame.canvas;

      // Convert layer cx/cy + bounding to canvas-local coordinate system rectangle
      return {
        x: canvas.w / 2 + layer.cx - layer.bounding.w / 2,
        y: canvas.h / 2 + layer.cy - layer.bounding.h / 2,
        w: layer.bounding.w,
        h: layer.bounding.h,
      } as LocalRect;
    },

    getConstraints: () => ({
      aspect: undefined,
      clamp: false,
    }),

    onUpdate: (e, newRect, tx) => {
      const editingId = e.state.interaction.signals[EDITING_TEXT_KEY] as string;
      const frame = e.activeFrame;
      const canvas = frame.canvas;
      // Get latest layer data from fast track (layer might be in fast track buffer during editing)
      const layer = e.actions.fast.latestLayer(frame.id, editingId) || frame.layers.byId[editingId];
      if (!layer) return;

      // Minimum size constraint
      const minW = 40;
      const minH = Math.max(20, (layer.textData?.fontSize || 24) * (layer.textData?.lineHeight || 1.4));
      const finalW = Math.max(minW, newRect.w);
      const finalH = Math.max(minH, newRect.h);

      // newRect (canvas-local) -> cx/cy (world coordinates)
      const newCx = newRect.x + finalW / 2 - canvas.w / 2;
      const newCy = newRect.y + finalH / 2 - canvas.h / 2;

      tx.update({
        cx: newCx,
        cy: newCy,
        bounding: { w: finalW, h: finalH },
        visibleShape: asLocalShape({ x: 0, y: 0, w: finalW, h: finalH }),
        textData: {
          ...layer.textData!,
          boxMode: 'fixed' as const,
          boxWidth: finalW,
          boxHeight: finalH,
        },
      }, 'layer', editingId);
    },

    onEnd: (_e, tx) => {
      tx.commit();
    },
  });
};

// ─── TextPlaceHandler ──────────────────────────────────────────────────────────

/**
 * TextPlaceHandler: Text placement interaction handler
 *
 * In text craft mode, click canvas to create a new text layer and enter editing state.
 */
export const createTextPlaceHandler = (): InteractionHandler => {
  return {
    id: 'text-place',
    priority: 150,

    test: (e) => {
      // Only active in craft mode and activeCraft === 'text'
      if (e.state.interaction.interactionMode !== 'craft') return false;
      if (e.state.interaction.signals[ACTIVE_CRAFT_KEY] !== 'text') return false;

      // No response if existing layer is being edited (taken over by InlineTextEditor)
      if (e.state.interaction.signals[EDITING_TEXT_KEY]) return false;

      // Exclude UI element clicks and resize handles
      const target = e.nativeEvent.target as HTMLElement;
      if (target.closest('button, a, input, [data-role="ui"], [contenteditable], [data-handle]')) return false;

      // Click within canvas range
      const frame = e.activeFrame;
      return e.geometry.space.isPointInRect(e.point.canvas, {
        x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h,
      });
    },

    onStart: (e) => {
      const frame = e.activeFrame;

      // Check if clicking an existing text layer -> wake up editing
      const hitTextLayer = findTextLayerAtPoint(frame, e.point.canvas);
      if (hitTextLayer) {
        // Enter editing state via command system (automatically establish undo baseline)
        e.actions.executeCommand(CMD_EDIT_START_UID, {
          frameId: frame.id,
          layerId: hitTextLayer.id,
        });
        return;
      }

      // No hit -> create new text layer via LayerFactory (automatically fill in all defaults)
      // Pixel alignment: use snapRectToPixel to align initial bounding box to canvas physical grid
      // (consistent with LayerMoveHandler onEnd)
      const rawCx = e.point.canvas.x - frame.canvas.w / 2;
      const rawCy = e.point.canvas.y - frame.canvas.h / 2;
      const initW = 100;
      const initH = 34;
      const alignedRect = e.geometry.snapping.snapRectToPixel(
        asWorldRect({ x: rawCx - initW / 2, y: rawCy - initH / 2, w: initW, h: initH }),
        frame.canvas
      );
      const alignedCenter = e.geometry.space.getRectCenter(alignedRect);
      const alignedCx = alignedCenter.x;
      const alignedCy = alignedCenter.y;

      const colorConfig = e.state.pluginConfig[ColorOptionsAPI.configKey] as { pendingColor?: string } | undefined;
      const initialColor = colorConfig?.pendingColor || '#FFFFFF';

      // Read pending text style from CraftDrawer's pluginConfig (user's pre-edit choices)
      const craftConfig = e.state.pluginConfig[CraftDrawerAPI.configKey] as { pendingTextData?: PendingTextData } | undefined;
      const pending = craftConfig?.pendingTextData;

      const layersArray = frame.layers.order.map(id => frame.layers.byId[id]);
      const smartName = LayerFactory.getNewLayerName(layersArray, 'Text');

      const textLayer = LayerFactory.getNewLayer({
        name: smartName,
        type: 'text',
        cx: alignedCx,
        cy: alignedCy,
        bounding: { w: initW, h: initH },  // reasonable initial size, will be updated to actual content size during editing
        visible: true,
        textData: {
          content: '',
          fontFamily: pending?.fontFamily || 'Inter',
          fontSize: pending?.fontSize || 24,
          fontWeight: pending?.fontWeight || 400,
          color: initialColor,
          align: pending?.align || 'left',
          lineHeight: pending?.lineHeight || 1.4,
          italic: pending?.italic || false,
          underline: pending?.underline || false,
          strikethrough: pending?.strikethrough || false,
          boxMode: 'auto',
        },
      });

      // Place layer via command system (automatically establish undo baseline)
      e.actions.executeCommand(CMD_PLACE_UID, {
        frameId: frame.id,
        layer: textLayer,
      });
    },

    onMove: () => {
      // Text tool does not require dragging
    },

    onEnd: () => {
      // Creation already completed in onStart
    },
  };
};
