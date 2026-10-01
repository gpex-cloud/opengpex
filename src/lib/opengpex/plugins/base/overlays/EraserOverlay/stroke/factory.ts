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
 * Mask Stroke Session Factory
 *
 * Creates a MaskStrokeSession for eraser/restore edits based on the current
 * interaction state and target layer. Mask edits never sample the brush colour
 * (they write pure white into a non-destructive mask), so no colour source is
 * read here — the config's `brushColor` is a fixed white to satisfy the shared
 * StampEngine signature.
 */

import type { InteractionEvent, Layer, Frame } from '@opengpex/editor/core/types';
import { LayerUtils } from '@opengpex/editor/core/layer/utils';
import { CraftDrawerAPI } from '../../../drawers/CraftDrawer/protocols';
import { LayersDrawerAPI, type MaskEditingSignal } from '../../../drawers/LayersDrawer/protocols';
import { DEFAULT_BRUSH_SIZE } from '../protocols';
import { MaskStrokeSession } from './MaskStrokeSession';
import type { StrokeSession, StrokeConfig } from './types';

/** Shared signal keys */
const ACTIVE_CRAFT_KEY = CraftDrawerAPI.signals.activeCraft;

// ─── Factory Function ──────────────────────────────────────────────────────────

/**
 * Creates a MaskStrokeSession for the current eraser/restore interaction.
 *
 * Returns null if no valid target layer exists or OffscreenCanvas creation fails.
 */
export function createStrokeSession(e: InteractionEvent): StrokeSession | null {
  const frame = e.activeFrame;
  const craft = e.state.interaction.signals[ACTIVE_CRAFT_KEY] as string;
  const isCmdPressed = e.keys.meta;

  const isEraser = craft === 'eraser';
  const isRestore = craft === 'restore';

  const config = readBrushConfig(e, frame);

  return createMaskSession(e, frame, config, isEraser, isRestore, isCmdPressed);
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
    console.warn('[EraserOverlay] No valid target layer for mask editing');
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

  // ── Mask coordinate basis (fragment coordinate fix) ──────────────────────────
  // The mask canvas keeps `bounding` DIMENSIONS, but its ORIGIN must coincide with
  // the origin of the layer content. `painter2d` blits content into the
  // bounding-local rect (vx, vy, vw, vh), so a mask anchored at (0,0) would be
  // disjoint from the content of a zero-copy logical fragment (where
  // visibleShape.rect.x/y != 0) → destination-in wipes the whole fragment.
  //
  // `maskOrigin` is the single basis shared by:
  //   1. stamp placement          (MaskStrokeSession subtracts it from local points)
  //   2. bm.bounds.x/y            (live-preview override + baked BitmapMask)
  // For regular full-layer images maskOrigin is (0,0) → behaviour unchanged.
  const maskOrigin = LayerUtils.getMaskOrigin(targetLayer);

  const maskW = targetLayer.bounding.w;
  const maskH = targetLayer.bounding.h;

  try {
    const maskCanvas = new OffscreenCanvas(maskW, maskH);
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) {
      console.warn('[EraserOverlay] Failed to get OffscreenCanvas 2D context for mask');
      return null;
    }

    // Bootstrap dispatches (below) happen before `MaskStrokeSession` exists,
    // so they can't use its `_version` counter yet. Both the sync dispatch
    // and the async-fallback dispatch write to the SAME `maskCanvas`
    // reference — if both used version 0, the engine's upload dedup would
    // treat the async dispatch (which just composited freshly-decoded mask
    // pixels in) as "unchanged" and silently drop them. `bootstrapVersion`
    // keeps the two dispatches distinguishable; `MaskStrokeSession` picks up
    // from here via `initialVersion` so its own counter never repeats a
    // bootstrap value.
    let bootstrapVersion = 0;

    // Constructed here (before the mask content is initialized below) so the
    // async load-fallback closure can close over the real instance instead of
    // a not-yet-assigned variable — `syncVersionFloor` then always reaches it,
    // even when the async load resolves before the caller's first move().
    const session = new MaskStrokeSession({
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
      maskOrigin,
      frameId: frame.id,
      initialVersion: bootstrapVersion,
    });

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
          bootstrapVersion += 1;
          // The session's own seed was snapshotted at construction time
          // (before this increment), so it's now stale — raise it so the
          // session's next move() doesn't repeat this dispatch's version.
          session.syncVersionFloor(bootstrapVersion);
          e.actions.fast.override(frame.id, targetLayer.id, {
            bitmapMaskOverride: { maskId, source: maskCanvas, bounds: maskOrigin, version: bootstrapVersion },
          }, 'layer');
        }).catch(err => {
          console.warn('[EraserOverlay] Async mask load failed:', err);
        });
      }
    }

    // Trigger initial fast-track override for live preview
    e.actions.fast.override(frame.id, targetLayer.id, {
      bitmapMaskOverride: { maskId, source: maskCanvas, bounds: maskOrigin, version: bootstrapVersion },
    }, 'layer');

    return session;
  } catch (err) {
    console.warn('[EraserOverlay] OffscreenCanvas creation for mask failed:', err);
    return null;
  }
}

// ─── Helper Functions ──────────────────────────────────────────────────────────

/**
 * Reads mask brush configuration from plugin state.
 *
 * Mask edits paint pure white into a non-destructive mask, so no brush colour is
 * sourced — `brushColor` is fixed to white purely to satisfy the shared
 * StampEngine signature (`MaskStrokeSession` ignores it and stamps white).
 */
function readBrushConfig(e: InteractionEvent, frame: Frame): StrokeConfig {
  const craftConfig = e.state.pluginConfig[CraftDrawerAPI.configKey] || {};

  return {
    brushSize: (craftConfig.brushSize as number) ?? DEFAULT_BRUSH_SIZE,
    brushColor: '#FFFFFF',
    brushOpacity: (craftConfig.brushOpacity as number) ?? 100,
    brushHardness: (craftConfig.brushHardness as number) ?? 80,
    canvasSize: { w: frame.canvas.w, h: frame.canvas.h },
  };
}

/**
 * Finds the target layer for eraser/mask editing.
 *
 * Eraser uses non-destructive bitmap masks, so it can operate on any layer
 * with a valid bounding box (image, paint, or text).
 * Strategy:
 * 1. Current active layer has visual content → use as mask target
 * 2. No valid target → return null
 */
export function findEraserTarget(frame: Frame): { layer: Layer; isNew: boolean } | null {
  const activeLayerId = frame.activeLayerId;
  const activeLayer = activeLayerId ? frame.layers.byId[activeLayerId] : null;

  if (!activeLayer || activeLayer.locked || !activeLayer.visible) return null;

  // Image/paint layers: require src (has pixel content)
  if (
    (activeLayer.type === 'image' || activeLayer.type === 'paint') &&
    activeLayer.src
  ) {
    return { layer: activeLayer, isNew: false };
  }

  // Text / vector layers: GPU-analytic or rendered content, no bitmap src —
  // gate on a valid bounding box instead.
  if (
    (activeLayer.type === 'text' || activeLayer.type === 'vector') &&
    activeLayer.bounding.w > 0 &&
    activeLayer.bounding.h > 0
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
