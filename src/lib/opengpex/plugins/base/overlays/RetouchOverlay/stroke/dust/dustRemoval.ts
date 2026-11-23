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
 * Remove Dust — programmatic dust removal via a thresholded disc median
 * (the Dust & Scratches technique; algorithm contract in medianDust.ts).
 *
 * Pipeline: rasterize the active layer into a canvas-space buffer → run the
 * thresholded median (dust = local outlier; median = clean neighbors; real
 * structure survives the threshold because the median is edge-preserving) →
 * build a patch buffer carrying ONLY the replaced pixels → resolve the
 * heal-family target layer (reuse/new, same strategy as a manual stroke) →
 * finalize through the shared PaintBake pipeline (bake.ts) so the product
 * lands on an independent heal layer with full undo/erase semantics.
 *
 * This replaces the previous detect-then-heal two-phase pipeline: any
 * detector must draw a threshold/cap line somewhere and every line misses
 * real dust or eats real texture. The thresholded median has no detection
 * step to get wrong — see medianDust.ts for the algorithm contract.
 *
 * The glue deliberately bypasses RetouchStrokeSession (no gesture exists)
 * but produces the SAME PaintBakeRequest shape a session's end() would, and
 * reuses `finalizePaintBake` byte-for-byte — one bake pipeline, two paths.
 *
 * Compute placement: everything is CPU on plain typed arrays with
 * `await yieldToUi()` between phases so the button press never freezes the
 * UI for the whole duration. The median pass is O(W·H·radius) via sliding
 * histogram; if large-canvas latency ever becomes a problem, it moves into
 * an engine worker job following the EXTRACT_PIXELS handler pattern — the
 * pure functions are already worker-shaped (plain buffers in/out).
 */

import type { Frame, Layer } from '@opengpex/editor/core/types';
import type { LayerService } from '@opengpex/editor/core/layer/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import type { RgbaBuffer } from '../heal/healKernel';
import { MODE_LAYER_NAME, MODE_SOURCE_TOOL } from '../types';
import type { PaintBakeRequest } from '../types';
import { finalizePaintBake } from '../bake';
import { dustAndScratchesMedian, buildReplacementPatch, dustThresholdForSensitivity } from './medianDust';

// ─── Configuration ─────────────────────────────────────────────────────────────

/** Services the glue needs — structurally satisfied by the React editor context. */
export interface DustRemovalDeps {
  layers: LayerService;
  pixels: Parameters<typeof finalizePaintBake>[0]['pixels'];
  assets: Parameters<typeof finalizePaintBake>[0]['assets'];
  actions: Parameters<typeof finalizePaintBake>[0]['actions'];
  activeFrame: Frame;
}

export interface DustRemovalResult {
  /** Number of pixels replaced by the median. 0 = nothing replaced (no layer created). */
  healed: number;
  /**
   * Why the run did nothing (always set when healed === 0). The caller picks
   * the user-facing message from this — a bare "nothing found" and a "this
   * layer cannot be scanned" read very differently in the HUD.
   */
  skipReason?: 'no-pixel-layer' | 'empty-layer' | 'transformed-layer' | 'no-specks';
}

// ─── Entry ─────────────────────────────────────────────────────────────────────

/**
 * Runs "Remove Dust" on the active layer of `deps.activeFrame`. Always
 * resolves with a result; `skipReason` tells the caller why nothing changed.
 */
export async function runFullFrameDustRemoval(deps: DustRemovalDeps, sensitivity: number): Promise<DustRemovalResult> {
  const frame = deps.activeFrame;
  const layer = frame.activeLayerId ? frame.layers.byId[frame.activeLayerId] : null;
  // House idiom: nature is only ever assigned EXPLICITLY for logical
  // fragments — ordinary physical layers (imports, baked products) leave it
  // undefined. So the fragment test is `=== 'logical'`, never `!== 'physical'`
  // (the latter would block every normal import).
  if (!layer || layer.type !== 'image' || layer.nature === 'logical') {
    console.warn('[RemoveDust] Active layer is not a physical image layer — skipped.');
    return { healed: 0, skipReason: 'no-pixel-layer' };
  }
  // A layer without a bitmap (fresh blank canvas, empty heal-family layer)
  // has nothing to scan — distinct from "wrong kind of layer" in the HUD.
  if (!layer.src) {
    console.warn('[RemoveDust] Active layer has no pixels (blank layer) — skipped.');
    return { healed: 0, skipReason: 'empty-layer' };
  }
  // The median runs in the layer's axis-aligned canvas rect. Rotated or
  // flipped poses would need a transform-aware sampler; those layers stay
  // manual (rare for scan/photo sources this feature targets).
  if (layer.rotation !== 0 || layer.flip.h || layer.flip.v) {
    console.warn('[RemoveDust] Active layer has a rotated/flipped pose — skipped.');
    return { healed: 0, skipReason: 'transformed-layer' };
  }

  const canvasW = frame.canvas.w;
  const canvasH = frame.canvas.h;
  const drawX = Math.round(canvasW / 2 + layer.cx - layer.bounding.w / 2);
  const drawY = Math.round(canvasH / 2 + layer.cy - layer.bounding.h / 2);

  // ── Phase 1: source buffer (one main-thread read, same as a session capture) ──
  const source = await rasterizeLayerToCanvasBuffer(deps.pixels, layer, canvasW, canvasH, drawX, drawY);
  if (!source) return { healed: 0, skipReason: 'no-pixel-layer' };
  await yieldToUi();

  // ── Phase 2: thresholded disc median (the whole "detector") ──
  const threshold = dustThresholdForSensitivity(sensitivity);
  const filtered = dustAndScratchesMedian(source, { threshold });
  await yieldToUi();

  // ── Phase 3: patch carries ONLY replaced pixels (heal-layer erase semantics) ──
  const { patch, dirtyRect } = buildReplacementPatch(source, filtered);
  if (!dirtyRect) return { healed: 0, skipReason: 'no-specks' };
  let replaced = 0;
  for (let i = 3; i < patch.length; i += 4) if (patch[i] !== 0) replaced++;
  await yieldToUi();

  // ── Phase 4: bake through the shared pipeline (same product as a manual stroke) ──
  const target = resolveHealTargetLayer(frame, deps.layers);
  const canvas = new OffscreenCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');
  if (!ctx) return { healed: 0, skipReason: 'no-specks' };
  ctx.putImageData(new ImageData(patch as unknown as ImageDataArray, canvasW, canvasH), 0, 0);
  const strokeBitmap = await createImageBitmap(canvas);
  const request: PaintBakeRequest = {
    type: 'image',
    strokeBitmap,
    targetLayer: target.layer,
    isNewLayer: target.isNew,
    canvasSize: { w: canvasW, h: canvasH },
    strokeDirtyRect: dirtyRect,
  };
  await finalizePaintBake(deps, request);
  return { healed: replaced };
}

// ─── Phase helpers ─────────────────────────────────────────────────────────────

/** Yields one macrotask so the UI paints between compute phases. */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Draws the active layer at its canvas pose into a canvas-size RGBA buffer
 * (transparent elsewhere). The median and the patch builder both read this
 * single buffer, so replacements land directly in canvas/bake coordinates.
 */
async function rasterizeLayerToCanvasBuffer(
  pixels: DustRemovalDeps['pixels'],
  layer: Layer,
  canvasW: number,
  canvasH: number,
  drawX: number,
  drawY: number,
): Promise<RgbaBuffer | null> {
  const bitmap = await pixels.image.acquireOwned(layer.src);
  if (!bitmap) {
    console.warn('[RemoveDust] Failed to acquire the active layer bitmap — skipped.');
    return null;
  }
  const canvas = new OffscreenCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, drawX, drawY, layer.bounding.w, layer.bounding.h);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, canvasW, canvasH);
  return { data: imageData.data, width: canvasW, height: canvasH };
}

/**
 * Heal-family target layer resolution — the same strategy as the stroke
 * session's findOrCreatePaintLayer: reuse the active layer when it is an
 * unlocked, visible, mask-free heal-family canvas; otherwise create a new
 * layer in the heal family (smart-named) so the dust product can be deleted
 * or erased independently of every other tool's pixels.
 */
function resolveHealTargetLayer(frame: Frame, layers: LayerService): { layer: Layer; isNew: boolean } {
  const activeLayer = frame.activeLayerId ? frame.layers.byId[frame.activeLayerId] : null;
  const hasMasks = activeLayer?.bitmapMasks && activeLayer.bitmapMasks.length > 0;
  if (
    !hasMasks &&
    activeLayer &&
    activeLayer.type === 'image' &&
    activeLayer.metadata?.sourceTool === MODE_SOURCE_TOOL.heal &&
    !activeLayer.locked &&
    activeLayer.visible
  ) {
    return { layer: activeLayer, isNew: false };
  }
  const smartName = layers.factory.getNewLayerNameFor(frame, MODE_LAYER_NAME.heal);
  const newLayer = LayerFactory.createLayer('blank', {
    name: smartName,
    cx: 0,
    cy: 0,
    bounding: { w: frame.canvas.w, h: frame.canvas.h },
    visible: true,
    metadata: { sourceTool: MODE_SOURCE_TOOL.heal },
  });
  return { layer: newLayer, isNew: true };
}
