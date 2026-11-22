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
import type { MosaicSessionMode, StrokeSession } from './types';

/**
 * Capture downsample target for the heal variant. The heal kernel does real
 * patch matching against the ring band around each stamp, so unlike mosaic
 * (average block colors only) it needs noticeably finer source detail; a
 * 1280px composite keeps patches (default 6px at scale 1) meaningful while
 * still bounding the readback buffer to a few MB.
 */
const HEAL_SAMPLE_TARGET_DIM = 1280;

/**
 * Sampling margin for heal, as a fraction of the brush radius. The kernel
 * samples the ring band r..1.5r OUTSIDE the stamp, so the composited source
 * must be trusted at least half a brush diameter beyond every stamp edge.
 * The capture itself is canvas-wide; this only documents the effective
 * range contract (and guards degenerate presets below).
 */
export const HEAL_SAMPLE_MARGIN_FACTOR = 0.5;

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
  // Alt (Option) = force this stroke into a NEW mosaic layer (since
  // 2026-10-26; Cmd was reassigned to the global move-layer spring key).
  const forceNewLayer = e.keys.alt;
  const activeLayerId = frame.activeLayerId;
  const activeLayer = activeLayerId ? frame.layers.byId[activeLayerId] : null;

  if (!activeLayer) {
    e.actions.notifyHUD('Mosaic needs a target layer', 'error');
    return null;
  }

  // Guard: mosaic is only meaningful when pixel content exists somewhere in the stack
  const hasPixelContent = frame.layers.order.some(id => {
    const l = frame.layers.byId[id];
    return l.visible && !l.hostId && l.type === 'image' && l.src;
  });
  if (!hasPixelContent) {
    e.actions.notifyHUD('Mosaic needs visible image/paint content', 'error');
    return null;
  }

  // Read preset size + active variant from CraftDrawer config. Heal is a
  // sub-mode of the single mosaic Craft button; the size presets table is
  // shared (for heal, `brushDiameter` is the stamp diameter and `blockSize`
  // is unused by the kernel).
  const craftConfig = e.state.pluginConfig[CraftDrawerAPI.configKey] as unknown as CraftDrawerConfig | undefined;
  const mode: MosaicSessionMode = craftConfig?.mosaicToolMode === 'heal' ? 'heal' : 'mosaic';
  const preset = craftConfig?.mosaicSizePreset ?? 'M';
  const presetData = MOSAIC_SIZE_PRESETS[preset as keyof typeof MOSAIC_SIZE_PRESETS] ?? MOSAIC_SIZE_PRESETS['M'];
  const { brushDiameter, blockSize } = presetData;

  // Downsample large canvases for mosaic/heal source readback.
  // The mosaic stroke session only needs average block colors (≤640 target);
  // heal does patch matching on a ring band around each stamp, so it needs
  // finer source detail — its composite target is relaxed to 1280px, which
  // still bounds the GPU readback buffer to a few MB and keeps the sRGB
  // encode within a frame.
  const maxDim = Math.max(frame.canvas.w, frame.canvas.h);
  let sampleScale = 1;
  const targetDim = mode === 'heal' ? HEAL_SAMPLE_TARGET_DIM : 640;
  if (maxDim > targetDim) {
    const targetScale = targetDim / maxDim;
    // Mosaic floor: blockSize maps to at least 1 sample pixel. Heal has no
    // block grid; its floor is the patch size, so patch matching never
    // degenerates below its minimum working scale.
    const minScale = mode === 'heal'
      ? Math.min(1, Math.max(0.25, 6 / brushDiameter))
      : (blockSize > 0 ? Math.min(1, 1 / blockSize) : targetScale);
    sampleScale = Math.min(1, Math.max(targetScale, minScale));
  }

  // Composite all visible layers into ImageData via the pure-memory capture channel.
  const compositePromise = e.pixels.render.capture(frame, { scale: sampleScale })
    .then(sampleImageData);

  try {
    return new MosaicStrokeSession(
      { brushDiameter, blockSize, mode, canvasSize: { w: frame.canvas.w, h: frame.canvas.h }, sampleScale, layers: e.layers },
      compositePromise,
      forceNewLayer,
      // Gesture-start selection snapshot (factory runs at gesture start).
      // Same contract as the eraser factory: deep copy (the live object gets
      // replaced during the stroke) and degenerate (zero-area) selections
      // normalize to null — a 0x0 "selection" must mean unconstrained.
      frame.confinement && frame.confinement.rect.w > 0 && frame.confinement.rect.h > 0
        ? e.geometry.polygon.translatePolygon(frame.confinement, 0, 0)
        : null,
    );
  } catch (err) {
    console.warn('[MosaicOverlay] MosaicStrokeSession creation failed:', err);
    return null;
  }
}
