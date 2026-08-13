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

/**
 * Stroke Session Factory
 *
 * Creates the appropriate StrokeSession (Paint or Mask) based on the current
 * interaction state, craft mode, and target layer.
 */

import type { InteractionEvent, Layer, Frame } from '@opengpex/editor/core/types';
import { CraftDrawerAPI, MOSAIC_SIZE_PRESETS } from '../../../drawers/CraftDrawer/protocols';
import type { CraftDrawerConfig } from '../../../drawers/CraftDrawer/protocols';
import { ColorOptionsAPI } from '../../../options/ColorOptions/protocols';
import { LayersDrawerAPI, type MaskEditingSignal } from '../../../drawers/LayersDrawer/protocols';
import { DEFAULT_BRUSH_SIZE } from '../protocols';
import { PaintStrokeSession } from './PaintStrokeSession';
import { MaskStrokeSession } from './MaskStrokeSession';
import { MosaicStrokeSession } from './MosaicStrokeSession';
import type { StrokeSession, StrokeConfig } from './types';

/** Shared signal keys */
const ACTIVE_CRAFT_KEY = CraftDrawerAPI.signals.activeCraft;

// ─── Factory Function ──────────────────────────────────────────────────────────

/**
 * Creates a StrokeSession based on the current interaction context.
 *
 * Returns null if the session cannot be created (e.g., no valid target for mask editing).
 */
export function createStrokeSession(e: InteractionEvent): StrokeSession | null {
  const frame = e.activeFrame;
  const craft = e.state.interaction.signals[ACTIVE_CRAFT_KEY] as string;
  const isCmdPressed = e.keys.meta;

  const isEraser = craft === 'eraser';
  const isRestore = craft === 'restore';
  const isMaskEdit = isEraser || isRestore;

  // Read brush parameters from pluginConfig
  const config = readBrushConfig(e, frame);

  if (craft === 'mosaic') {
    return createMosaicSession(e, frame, isCmdPressed);
  } else if (!isMaskEdit) {
    return createPaintSession(config, craft, isCmdPressed);
  } else {
    return createMaskSession(e, frame, config, isEraser, isRestore, isCmdPressed);
  }
}

// ─── Paint Session Creation ────────────────────────────────────────────────────

function createPaintSession(
  config: StrokeConfig,
  craft: string,
  isCmdPressed: boolean,
): StrokeSession | null {
  const forceNewLayer = craft === 'brush' && isCmdPressed;

  try {
    return new PaintStrokeSession(config, forceNewLayer);
  } catch (err) {
    console.warn('[BrushOverlay] OffscreenCanvas creation failed:', err);
    return null;
  }
}

// ─── Mask Session Creation ─────────────────────────────────────────────────────

function createMaskSession(
  e: InteractionEvent,
  frame: Frame,
  config: StrokeConfig,
  isEraser: boolean,
  isRestore: boolean,
  isCmdPressed: boolean,
): StrokeSession | null {
  const forceNewMask = isEraser && isCmdPressed;

  // Find target layer for mask editing
  const targetLayerInfo = findEraserTarget(frame);
  if (!targetLayerInfo) {
    console.warn('[BrushOverlay] No valid target layer for mask editing');
    return null;
  }
  const targetLayer = targetLayerInfo.layer;

  // Mask target selection strategy:
  //   1. Check maskEditing signal (from LayerDrawerAPI)
  //   2. Fallback to topmost (last in array) enabled mask
  //   3. Or force create new mask (Eraser + Cmd)
  const maskEditing = e.state.interaction.signals[LayersDrawerAPI.signals.maskEditing] as MaskEditingSignal;
  const hasFocusedMask = maskEditing && maskEditing.layerId === targetLayer.id;

  const enabledMasks = targetLayer.bitmapMasks?.filter(m => m.enabled) ?? [];
  const activeMask = forceNewMask
    ? undefined
    : (hasFocusedMask
        ? targetLayer.bitmapMasks?.find(m => m.id === maskEditing.maskId)
        : (enabledMasks.length > 0 ? enabledMasks[enabledMasks.length - 1] : undefined));
  const maskId = activeMask?.id || (hasFocusedMask ? maskEditing.maskId : `mask-${Date.now()}`);

  // Compute local-space transform
  const localMatrix = e.geometry.transform.getLayerLocalMatrix(targetLayer, frame);
  const localMatrixInverse = localMatrix.inverse();
  const scaleX = Math.sqrt(localMatrix.a * localMatrix.a + localMatrix.b * localMatrix.b) || 1;
  const localBrushSize = config.brushSize / scaleX;

  const maskW = targetLayer.bounding.w;
  const maskH = targetLayer.bounding.h;

  try {
    const maskCanvas = new OffscreenCanvas(maskW, maskH);
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) {
      console.warn('[BrushOverlay] Failed to get OffscreenCanvas 2D context for mask');
      return null;
    }

    // Initialize mask canvas content
    if (!activeMask) {
      // New mask: start with white (fully visible)
      maskCtx.fillStyle = '#FFFFFF';
      maskCtx.fillRect(0, 0, maskW, maskH);
    } else if (activeMask.src) {
      // Existing mask: draw current content
      const bmp = e.pixels.image.ensureBitmap(activeMask.src);
      if (bmp) {
        maskCtx.drawImage(bmp, 0, 0, maskW, maskH);
      } else {
        // Async fallback: load bitmap in background
        loadImageBitmap(activeMask.src).then(bitmap => {
          maskCtx.save();
          maskCtx.globalCompositeOperation = 'destination-over';
          maskCtx.drawImage(bitmap, 0, 0, maskW, maskH);
          maskCtx.restore();
          bitmap.close();
          // Retrigger preview after async load
          e.actions.fast.override(frame.id, targetLayer.id, {
            bitmapMaskOverride: { maskId, source: maskCanvas },
          }, 'layer');
        }).catch(err => {
          console.warn('[BrushOverlay] Async mask load failed:', err);
        });
      }
    }

    // Trigger initial fast-track override for live preview
    e.actions.fast.override(frame.id, targetLayer.id, {
      bitmapMaskOverride: { maskId, source: maskCanvas },
    }, 'layer');

    return new MaskStrokeSession({
      config,
      isEraser,
      isRestore,
      targetLayerId: targetLayer.id,
      maskId,
      existingMaskId: activeMask?.id,
      maskCanvas,
      maskCtx,
      localMatrixInverse,
      localBrushSize,
      frameId: frame.id,
    });
  } catch (err) {
    console.warn('[BrushOverlay] OffscreenCanvas creation for mask failed:', err);
    return null;
  }
}

// ─── Mosaic Session Creation ───────────────────────────────────────────────────

function createMosaicSession(
  e: InteractionEvent,
  frame: Frame,
  isCmdPressed: boolean,
): StrokeSession | null {
  const forceNewLayer = isCmdPressed;
  const activeLayerId = frame.activeLayerId;
  const activeLayer = activeLayerId ? frame.layers.byId[activeLayerId] : null;

  if (!activeLayer) {
    e.actions.notifyHUD('Mosaic needs a target layer', 'error');
    return null;
  }

  // Find the SOURCE image layer for pixel reading.
  // Mosaic only READS from the source (never modifies it), so locked layers are valid sources.
  // Mosaic writes to a paint layer, so lock check applies only to the target paint layer
  // (handled in MosaicStrokeSession.findOrCreatePaintLayer at end time).
  let sourceLayer: Layer | null = null;

  if (activeLayer.type === 'image' && activeLayer.src && !activeLayer.hostId) {
    // Active layer IS the image host → use it directly as source (lock doesn't matter, we only read)
    sourceLayer = activeLayer;
  } else if (activeLayer.type === 'paint' || activeLayer.type === 'image') {
    // Active layer is paint (e.g. from a previous mosaic stroke) or a non-host image layer
    // → find the nearest HOST image layer in the stack
    const layerOrder = frame.layers.order;
    const activeIdx = layerOrder.indexOf(activeLayerId!);
    // Search below in stack (lower index = below)
    for (let i = activeIdx - 1; i >= 0; i--) {
      const layer = frame.layers.byId[layerOrder[i]];
      // Only match HOST image layers (skip role/child layers created by expandLayers)
      if (layer.type === 'image' && layer.visible && layer.src && !layer.hostId) {
        sourceLayer = layer;
        break;
      }
    }
    // If not found below, search above
    if (!sourceLayer) {
      for (let i = activeIdx + 1; i < layerOrder.length; i++) {
        const layer = frame.layers.byId[layerOrder[i]];
        if (layer.type === 'image' && layer.visible && layer.src && !layer.hostId) {
          sourceLayer = layer;
          break;
        }
      }
    }
  } else {
    e.actions.notifyHUD('Mosaic only works on image/paint layers', 'error');
    return null;
  }

  if (!sourceLayer) {
    e.actions.notifyHUD('Mosaic needs an image layer as source', 'error');
    return null;
  }

  // Read preset size from CraftDrawer config
  const craftConfig = e.state.pluginConfig[CraftDrawerAPI.configKey] as unknown as CraftDrawerConfig | undefined;
  const preset = craftConfig?.mosaicSizePreset ?? 'M';
  const presetData = MOSAIC_SIZE_PRESETS[preset as keyof typeof MOSAIC_SIZE_PRESETS] ?? MOSAIC_SIZE_PRESETS['M'];
  const { brushDiameter, blockSize } = presetData;

  // Pre-check: ensure source bitmap is available (must be cached since layer is visible)
  const sourceBitmap = e.pixels.image.ensureBitmap(sourceLayer.src!);
  if (!sourceBitmap) {
    console.warn('[BrushOverlay] Source bitmap not available for mosaic');
    e.actions.notifyHUD('Image not ready, try again', 'error');
    return null;
  }

  try {
    return new MosaicStrokeSession(
      { brushDiameter, blockSize, canvasSize: { w: frame.canvas.w, h: frame.canvas.h } },
      sourceLayer,
      sourceBitmap,
      forceNewLayer,
    );
  } catch (err) {
    console.warn('[BrushOverlay] MosaicStrokeSession creation failed:', err);
    return null;
  }
}

// ─── Helper Functions ──────────────────────────────────────────────────────────

/**
 * Reads brush configuration from plugin state.
 */
function readBrushConfig(e: InteractionEvent, frame: Frame): StrokeConfig {
  const craftConfig = e.state.pluginConfig[CraftDrawerAPI.configKey] || {};
  const colorConfig = e.state.pluginConfig[ColorOptionsAPI.configKey] || {};

  return {
    brushSize: (craftConfig.brushSize as number) ?? DEFAULT_BRUSH_SIZE,
    brushColor: (colorConfig.pendingColor as string) || '#FFFFFF',
    brushOpacity: (craftConfig.brushOpacity as number) ?? 100,
    brushHardness: (craftConfig.brushHardness as number) ?? 80,
    canvasSize: { w: frame.canvas.w, h: frame.canvas.h },
  };
}

/**
 * Finds the target layer for eraser/mask editing.
 *
 * Eraser can operate on any layer with content (image or paint type).
 * Strategy:
 * 1. Current active layer has bitmap content (non-empty src) -> erase directly
 * 2. No valid target -> return null
 */
export function findEraserTarget(frame: Frame): { layer: Layer; isNew: boolean } | null {
  const activeLayerId = frame.activeLayerId;
  const activeLayer = activeLayerId ? frame.layers.byId[activeLayerId] : null;

  if (
    activeLayer &&
    (activeLayer.type === 'image' || activeLayer.type === 'paint') &&
    activeLayer.src &&
    !activeLayer.locked &&
    activeLayer.visible
  ) {
    return { layer: activeLayer, isNew: false };
  }

  return null;
}

/**
 * Loads image as ImageBitmap via URL.
 */
async function loadImageBitmap(src: string): Promise<ImageBitmap> {
  const response = await fetch(src);
  const blob = await response.blob();
  return createImageBitmap(blob);
}
