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
 * Creates a RetouchStrokeSession based on current interaction context.
 */

import type { InteractionEvent, Frame } from '@opengpex/editor/core/types';
import { sampleImageData } from '@opengpex/editor/core/engine/utils/sample-utils';
import { CraftDrawerAPI, MOSAIC_SIZE_PRESETS } from '../../../drawers/CraftDrawer/protocols';
import type { CraftDrawerConfig } from '../../../drawers/CraftDrawer/protocols';
import { RetouchStrokeSession } from './session';
import { normalizeMosaicMode, RETOUCH_SPACING_RATIO } from './types';
import { getCloneSourceFor } from './clone/cloneSource';
import type { StrokeSession } from './types';

/**
 * Capture downsample target for the heal variant. The heal kernel does real
 * patch matching against the ring band around each stamp, so unlike mosaic
 * (average block colors only) it needs noticeably finer source detail; a
 * 1280px composite keeps patches (default 6px at scale 1) meaningful while
 * still bounding the readback buffer to a few MB.
 */
const HEAL_SAMPLE_TARGET_DIM = 1280;

// ─── Mosaic Session Creation ───────────────────────────────────────────────────

/**
 * Creates a RetouchStrokeSession using compositeFrame as pixel source.
 *
 * Source pixel strategy — "What You See Is What Gets Pixelated":
 *   Instead of reading pixels from a single source layer, we composite ALL
 *   visible layers via capture(). This correctly handles:
 *   - Fragment layers (cut/copy) with shared bitmaps and visibleShape offsets
 *   - Paint strokes overlaid on images
 *   - Text layers, adjustment effects, masks, blend modes, etc.
 *
 *   The composite is async (~5-15ms). RetouchStrokeSession buffers early
 *   pointer events and replays them once the composite resolves.
 *
 * Guard: we still require at least one visible image/paint layer exists
 *   so that mosaic on a blank canvas / pure text doesn't silently do nothing.
 */
export function createRetouchSession(e: InteractionEvent): StrokeSession | null {
  const frame: Frame = e.activeFrame;
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

  // Read preset size + active variant from CraftDrawer config. Every mode is
  // a sub-mode of the single mosaic Craft button; the size presets table is
  // shared (brushDiameter is the stamp diameter everywhere; blockSize is
  // only meaningful to the mosaic kernel). Mode normalization goes through
  // the shared whitelist so stale/partial config can never route a stroke to
  // the wrong kernel.
  const craftConfig = e.state.pluginConfig[CraftDrawerAPI.configKey] as unknown as CraftDrawerConfig | undefined;
  const mode = normalizeMosaicMode(craftConfig?.mosaicToolMode);
  const preset = craftConfig?.mosaicSizePreset ?? 'M';
  const presetData = MOSAIC_SIZE_PRESETS[preset as keyof typeof MOSAIC_SIZE_PRESETS] ?? MOSAIC_SIZE_PRESETS['M'];
  // Custom diameter override (typed into the panel's Diameter row) wins over
  // the preset; the mosaic block grid follows at the presets' ratio (d/2.5).
  const customDiameter = craftConfig?.mosaicStampDiameter;
  const isCustomDiameter = customDiameter != null && customDiameter > 0;
  const brushDiameter = isCustomDiameter ? customDiameter : presetData.brushDiameter;
  const blockSize = isCustomDiameter
    ? Math.max(2, Math.round(brushDiameter / 2.5))
    : presetData.blockSize;

  // Convolution parameters for blur/sharpen (panel sliders; canvas-space
  // radius px, strength in [0,100] → [0,1]. The kernels re-scale the radius
  // into sample space).
  const blurRadius = craftConfig?.mosaicBlurRadius ?? 8;
  const strength = (craftConfig?.mosaicBlurStrength ?? 60) / 100;
  const hardness = craftConfig?.retouchHardness ?? 75;

  // Downsample large canvases for source readback.
  // The mosaic stroke session only needs average block colors (≤640 target);
  // every other mode does real per-pixel work on the stamp neighborhood
  // (heal's ring band matching, blur/sharpen convolutions, clone's patch
  // copy), so they share the finer 1280px composite target — it still bounds
  // the GPU readback buffer to a few MB and keeps the sRGB encode within a
  // frame.
  const maxDim = Math.max(frame.canvas.w, frame.canvas.h);
  let sampleScale = 1;
  const targetDim = mode === 'mosaic' ? 640 : HEAL_SAMPLE_TARGET_DIM;
  if (maxDim > targetDim) {
    const targetScale = targetDim / maxDim;
    // Per-mode sampling floors (same rationale as the historical heal floor):
    // mosaic needs blockSize to survive as ≥1 sample pixel; blur/sharpen
    // need the box blur kernel at least 2 sample pixels wide so the
    // convolution never degenerates to a point lookup; heal/clone do patch
    // work sized by the stamp diameter, so the patch floor applies.
    const minScale = mode === 'mosaic'
      ? (blockSize > 0 ? Math.min(1, 1 / blockSize) : targetScale)
      : mode === 'blur' || mode === 'sharpen'
        ? Math.min(1, Math.max(0.25, 2 / Math.max(1, blurRadius)))
        : Math.min(1, Math.max(0.25, 6 / brushDiameter));
    sampleScale = Math.min(1, Math.max(targetScale, minScale));
  }

  // Clone needs a picked source anchor before any stroke can run (the
  // interaction handler enforces the Alt+Click pick and the not-set guard;
  // this is the belt-and-suspenders re-check at session level).
  const cloneSource = mode === 'clone' ? getCloneSourceFor(frame.id)?.anchor ?? null : null;
  if (mode === 'clone' && !cloneSource) {
    e.actions.notifyHUD('Clone needs a source: Alt+Click to pick one', 'error');
    return null;
  }

  // Composite all visible layers into ImageData via the pure-memory capture channel.
  const compositePromise = e.pixels.render.capture(frame, { scale: sampleScale })
    .then(sampleImageData);

  try {
    return new RetouchStrokeSession(
      {
        stamp: { brushDiameter, spacingRatio: RETOUCH_SPACING_RATIO },
        blockSize,
        mode,
        canvasSize: { w: frame.canvas.w, h: frame.canvas.h },
        sampleScale,
        layers: e.layers,
        blurRadius,
        strength,
        hardness,
        cloneSource,
        cloneFrameId: frame.id,
      },
      compositePromise,
      // Gesture-start selection snapshot (factory runs at gesture start).
      // Same contract as the eraser factory: deep copy (the live object gets
      // replaced during the stroke) and degenerate (zero-area) selections
      // normalize to null — a 0x0 "selection" must mean unconstrained.
      frame.confinement && frame.confinement.rect.w > 0 && frame.confinement.rect.h > 0
        ? e.geometry.polygon.translatePolygon(frame.confinement, 0, 0)
        : null,
    );
  } catch (err) {
    console.warn('[RetouchOverlay] RetouchStrokeSession creation failed:', err);
    return null;
  }
}
