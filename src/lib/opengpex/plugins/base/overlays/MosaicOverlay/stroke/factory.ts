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
 * Mosaic Stroke Session Factory
 *
 * Creates a MosaicStrokeSession based on current interaction context.
 */

import type { InteractionEvent, Frame } from '@opengpex/editor/core/types';
import { sampleImageData } from '@opengpex/editor/core/engine/utils/sample-utils';
import { CraftDrawerAPI, MOSAIC_SIZE_PRESETS } from '../../../drawers/CraftDrawer/protocols';
import type { CraftDrawerConfig } from '../../../drawers/CraftDrawer/protocols';
import { MosaicStrokeSession } from './MosaicStrokeSession';
import type { StrokeSession } from './types';

// ─── Mosaic Session Creation ───────────────────────────────────────────────────

/**
 * Creates a MosaicStrokeSession using compositeFrame as pixel source.
 *
 * Source pixel strategy — "What You See Is What Gets Pixelated":
 *   Instead of reading pixels from a single source layer, we composite ALL
 *   visible layers via capture(). This correctly handles:
 *   - Fragment layers (cut/copy) with shared bitmaps and visibleShape offsets
 *   - Paint strokes overlaid on images
 *   - Text layers, adjustment effects, masks, blend modes, etc.
 *
 *   The composite is async (~5-15ms). MosaicStrokeSession buffers early
 *   pointer events and replays them once the composite resolves.
 *
 * Guard: we still require at least one visible image/paint layer exists
 *   so that mosaic on a blank canvas / pure text doesn't silently do nothing.
 */
export function createMosaicSession(e: InteractionEvent): StrokeSession | null {
  const frame: Frame = e.activeFrame;
  const isCmdPressed = e.keys.meta;
  const forceNewLayer = isCmdPressed;
  const activeLayerId = frame.activeLayerId;
  const activeLayer = activeLayerId ? frame.layers.byId[activeLayerId] : null;

  if (!activeLayer) {
    e.actions.notifyHUD('Mosaic needs a target layer', 'error');
    return null;
  }

  // Guard: mosaic is only meaningful when pixel content exists somewhere in the stack
  const hasPixelContent = frame.layers.order.some(id => {
    const l = frame.layers.byId[id];
    return l.visible && !l.hostId && (l.type === 'image' || l.type === 'paint') && l.src;
  });
  if (!hasPixelContent) {
    e.actions.notifyHUD('Mosaic needs visible image/paint content', 'error');
    return null;
  }

  // Read preset size from CraftDrawer config
  const craftConfig = e.state.pluginConfig[CraftDrawerAPI.configKey] as unknown as CraftDrawerConfig | undefined;
  const preset = craftConfig?.mosaicSizePreset ?? 'M';
  const presetData = MOSAIC_SIZE_PRESETS[preset as keyof typeof MOSAIC_SIZE_PRESETS] ?? MOSAIC_SIZE_PRESETS['M'];
  const { brushDiameter, blockSize } = presetData;

  // Downsample large canvases (max dimension > 640) for mosaic source readback.
  // The mosaic stroke session only needs average block colors. Downsampling to ≤640
  // ensures the GPU readback buffer is only ~6.5MB (vs 392MB) and CPU sRGB gamut
  // encode finishes in ~15ms (1 frame, vs 400ms freeze), eliminating mousedown frame drops.
  const maxDim = Math.max(frame.canvas.w, frame.canvas.h);
  let sampleScale = 1;
  const targetDim = 640;
  if (maxDim > targetDim) {
    const targetScale = targetDim / maxDim;
    const minScale = blockSize > 0 ? Math.min(1, 1 / blockSize) : targetScale;
    sampleScale = Math.min(1, Math.max(targetScale, minScale));
  }

  // Composite all visible layers into ImageData via the pure-memory capture channel.
  const compositePromise = e.pixels.render.capture(frame, { scale: sampleScale })
    .then(sampleImageData);

  try {
    return new MosaicStrokeSession(
      { brushDiameter, blockSize, canvasSize: { w: frame.canvas.w, h: frame.canvas.h }, sampleScale },
      compositePromise,
      forceNewLayer,
    );
  } catch (err) {
    console.warn('[MosaicOverlay] MosaicStrokeSession creation failed:', err);
    return null;
  }
}
