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
 * Bake Pipeline
 *
 * Executes the bake process for completed strokes:
 * - Paint: offloaded to plugin Worker (composite + bounds + encode), then
 *   finalize on main thread (register asset + writeBitmap + CMD_BAKE).
 *   Main thread blocking reduced from ~80-220ms to <5ms.
 * - Mask: register encoded blob → update/add bitmap mask → fast.commit
 */

import type { InteractionEvent, Layer } from '@opengpex/editor/core/types';
import { asLocalRect, asLocalShape } from '@opengpex/editor/core/types';
import { bakeWorkerClient } from './bake-worker-client';
import { _CMD_BAKE_UID } from '../protocols';
import type { BakeRequest, PaintBakeRequest, MaskBakeRequest } from './types';

/** Command UID (from protocols, Single Source of Truth) */
const CMD_BAKE_UID = _CMD_BAKE_UID;

// ─── Main Entry ────────────────────────────────────────────────────────────────

/**
 * Executes the bake process for a completed stroke.
 *
 * Routes to paint or mask bake based on request type.
 */
export async function executeBake(request: BakeRequest, e: InteractionEvent): Promise<void> {
  if (request.type === 'paint') {
    await executePaintBake(request, e);
  } else {
    await executeMaskBake(request, e);
  }
}

// ─── Paint Bake ────────────────────────────────────────────────────────────────

async function executePaintBake(request: PaintBakeRequest, e: InteractionEvent): Promise<void> {
  const { strokeBitmap, targetLayer, isNewLayer, canvasSize, strokeDirtyRect } = request;
  const frame = e.activeFrame;

  // ── Phase 1: Prepare transferables (main thread, <2ms) ──
  let existingBitmap: ImageBitmap | null = null;
  let existingLayerRect: { x: number; y: number; w: number; h: number } | null = null;
  let existingLayerBounding: { w: number; h: number; cx: number; cy: number } | null = null;

  if (targetLayer.src && !isNewLayer) {
    try {
      existingBitmap = await e.pixels.image.acquireOwned(targetLayer.src);
      if (existingBitmap) {
        const drawX = canvasSize.w / 2 + targetLayer.cx - targetLayer.bounding.w / 2;
        const drawY = canvasSize.h / 2 + targetLayer.cy - targetLayer.bounding.h / 2;
        existingLayerRect = { x: drawX, y: drawY, w: targetLayer.bounding.w, h: targetLayer.bounding.h };
        existingLayerBounding = { w: targetLayer.bounding.w, h: targetLayer.bounding.h, cx: targetLayer.cx, cy: targetLayer.cy };
      }
    } catch (loadErr) {
      console.warn('[BrushOverlay] Failed to acquireOwned existing layer bitmap:', loadErr);
    }
  }

  // ── Phase 2: Plugin Worker (main thread free) ──
  const result = await bakeWorkerClient.execute({
    existingBitmap,
    existingLayerRect,
    strokeBitmap,
    canvasSize,
    isNewLayer,
    strokeDirtyRect,
    existingLayerBounding,
  });

  // ── Phase 3: Finalize on main thread (<2ms) ──
  // Order matters: register() triggers onRegistered → warmFromBlob (async),
  // then writeBitmap() synchronously injects the Worker-decoded bitmap into
  // SourceBitmapCache *before* warmFromBlob completes. The SBC.warmFromBlob
  // cache-hit guard skips the redundant decode, preventing an extra notify().
  const asset = await e.assets.register(
    result.blob,
    { w: result.cropW, h: result.cropH },
    { precomputedHash: result.hash },
  );
  e.pixels.image.writeBitmap(asset.url, result.bitmap);

  const cropCenterLocalX = result.cropX + result.cropW / 2;
  const cropCenterLocalY = result.cropY + result.cropH / 2;

  const completeLayer: Layer = {
    ...targetLayer,
    assetId: asset.assetId,
    src: asset.url,
    bounding: { w: result.cropW, h: result.cropH },
    visibleShape: asLocalShape({ x: 0, y: 0, w: result.cropW, h: result.cropH }),
    cx: cropCenterLocalX - canvasSize.w / 2,
    cy: cropCenterLocalY - canvasSize.h / 2,
  };

  e.actions.executeCommand(CMD_BAKE_UID, {
    frameId: frame.id,
    layer: completeLayer,
    isNew: isNewLayer,
  });
}

// ─── Mask Bake ─────────────────────────────────────────────────────────────────

async function executeMaskBake(request: MaskBakeRequest, e: InteractionEvent): Promise<void> {
  const { blob, targetLayerId, existingMaskId, maskBounds } = request;
  const frame = e.activeFrame;

  try {
    // Register mask blob as asset
    const asset = await e.assets.register(blob, { w: maskBounds.w, h: maskBounds.h });

    // Pre-warm the decode cache for the baked mask asset
    await e.pixels.image.cacheBitmap(asset.url, blob);

    // Update existing mask or add new mask
    if (existingMaskId) {
      await e.actions.adv.layer.bitmapMask.update.execute({
        frameId: frame.id,
        layerId: targetLayerId,
        maskId: existingMaskId,
        patch: {
          src: asset.url,
          assetId: asset.assetId,
          // Re-assert bounds: an older mask may have been persisted before the
          // fragment origin fix (bounds.x/y === 0). Rewriting it keeps the reused
          // mask on the same basis the stamps were just drawn in.
          bounds: asLocalRect({
            x: maskBounds.x, y: maskBounds.y, w: maskBounds.w, h: maskBounds.h,
          }),
        },
      });
    } else {
      await e.actions.adv.layer.bitmapMask.add.execute({
        frameId: frame.id,
        layerId: targetLayerId,
        src: asset.url,
        assetId: asset.assetId,
        bounds: asLocalRect({
          x: maskBounds.x, y: maskBounds.y, w: maskBounds.w, h: maskBounds.h,
        }),
      });
    }
  } finally {
    // Commit the fast-track override (clear live preview)
    e.actions.fast.commit(targetLayerId, 'layer');
  }
}

