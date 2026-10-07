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
 * (they write pure white into a non-destructive mask), so `StrokeConfig` carries
 * no colour field — `MaskStrokeSession` stamps white unconditionally.
 */

import type { InteractionEvent, Layer, Frame, BitmapMask } from '@opengpex/editor/core/types';
import { LayerUtils } from '@opengpex/editor/core/layer/utils';
import { CraftDrawerAPI } from '../../../drawers/CraftDrawer/protocols';
import { LayersDrawerAPI, type MaskEditingSignal } from '../../../drawers/LayersDrawer/protocols';
import { DEFAULT_BRUSH_SIZE } from '../protocols';
import { MaskStrokeSession } from './MaskStrokeSession';
import type { MaskSessionRecordDesc } from './MaskStrokeSession';
import type { StrokeSession, StrokeConfig } from './types';

/** Shared signal keys */
const ACTIVE_CRAFT_KEY = CraftDrawerAPI.signals.activeCraft;

// ─── Factory Function ──────────────────────────────────────────────────────────

/**
 * Creates a MaskStrokeSession for the current eraser/restore interaction.
 *
 * Returns null if no valid target layer exists.
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
  // `forceNewMask` (Eraser + Cmd) bypasses ERASE-family record matching — the
  // erase stroke always bakes as a brand-new record. The restore family keeps
  // its normal targeting: Cmd is an erase-side gesture, and a Tab flip to
  // restore mid-stroke must still resume the matching restore record.
  const forceNewMask = isEraser && isCmdPressed;

  // Find target layer for mask editing
  const targetLayerInfo = findEraserTarget(frame);
  if (!targetLayerInfo) {
    // Surface the rejection as a HUD hint (same channel as the layer commands):
    // the common causes are an explicitly locked or hidden active layer; anything
    // else (no active layer, no pixel content / empty bounding) stays generic.
    const activeLayer = frame.activeLayerId ? frame.layers.byId[frame.activeLayerId] : null;
    const message = !activeLayer
      ? 'No editable layer selected'
      : activeLayer.locked
        ? 'Layer is locked'
        : !activeLayer.visible
          ? 'Layer is hidden'
          : 'No valid target layer for mask editing';
    e.actions.setInteraction({ hud: { message, type: 'error' } });
    return null;
  }
  const targetLayer = targetLayerInfo.layer;

  const maskEditing = e.state.interaction.signals[LayersDrawerAPI.signals.maskEditing] as MaskEditingSignal;
  const hasFocusedMask = maskEditing && maskEditing.layerId === targetLayer.id;

  const enabledMasks = targetLayer.bitmapMasks?.filter(m => m.enabled) ?? [];

  // ── FAMILY-DISCRIMINATED TARGET SELECTION ────────────────────────────────────
  // `BitmapMask.inverted` is the family discriminator: erase family (false,
  // contributes α to the combine PRODUCT) vs restore family (true, contributes
  // 1−α to the combine MAX). The SAME AA-aware rule runs INDEPENDENTLY inside
  // each family — a stroke may only accumulate into a record whose hard flag
  // matches its own (the GPU thresholds the record's ENTIRE texture at sample
  // time, so a mismatched write would flip that record's whole history):
  //   1. The focused mask (LayersDrawer signal) IF it belongs to this family
  //      and its hard flag matches
  //   2. The newest enabled record of this family whose hard flag matches (an
  //      AA toggle-back resumes the matching record instead of piling up new
  //      ones)
  //   3. No match → a fresh record is created at bake time (add branch carries
  //      the family's `inverted` flag). The mismatch case IS the AA-toggle
  //      record split; each family converges to at most a soft and a hard
  //      record — two families × two hard flags = the architecture's four
  //      records-per-layer ceiling.
  const selectFamilyTarget = (familyInverted: boolean, respectForceNew: boolean): BitmapMask | undefined => {
    if (respectForceNew) return undefined;
    if (hasFocusedMask) {
      const focused = targetLayer.bitmapMasks?.find(m => m.id === maskEditing.maskId);
      if (focused && !!focused.inverted === familyInverted && !!focused.hard === !!config.hard) return focused;
    }
    for (let i = enabledMasks.length - 1; i >= 0; i--) {
      const m = enabledMasks[i];
      if (!!m.inverted === familyInverted && !!m.hard === !!config.hard) return m;
    }
    return undefined;
  };

  const eraseTarget = selectFamilyTarget(false, forceNewMask);
  const restoreTarget = selectFamilyTarget(true, false);

  // ── PINNED RECORD SET (fixed for the whole stroke) ───────────────────────────
  // Both family targets (a Tab flip mid-stroke must reuse them — existing
  // convention) plus every PAINTED restore-family record (the erase op's
  // hole-fill set). Pristine restore records (`painted === false`) are excluded:
  // hole-filling an all-white record is a visual no-op that would only waste an
  // epoch bump and an upload. Deduped by maskId — a painted restore record that
  // IS the restore target appears once and serves both roles.
  const records: MaskSessionRecordDesc[] = [];
  const pinnedIds = new Set<string>();
  const pin = (
    maskId: string,
    target: BitmapMask | undefined,
    inverted: boolean,
  ): void => {
    if (pinnedIds.has(maskId)) return;
    pinnedIds.add(maskId);
    records.push({
      maskId,
      existingMaskId: target?.id,
      src: target?.src,
      inverted,
      hard: target ? !!target.hard : config.hard,
      painted: target ? target.painted !== false : false,
    });
  };
  pin(eraseTarget?.id ?? `mask-${Date.now()}-erase`, eraseTarget, false);
  pin(restoreTarget?.id ?? `mask-${Date.now()}-restore`, restoreTarget, true);
  for (let i = enabledMasks.length - 1; i >= 0; i--) {
    const m = enabledMasks[i];
    if (!m.inverted || m.painted === false) continue;
    pin(m.id, m, true);
  }

  // Compute local-space transform
  const localMatrix = e.geometry.transform.getLayerLocalMatrix(targetLayer, frame);
  const localMatrixInverse = localMatrix.inverse();
  const scaleX = Math.sqrt(localMatrix.a * localMatrix.a + localMatrix.b * localMatrix.b) || 1;
  const localBrushSize = config.size / scaleX;

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

  const session = new MaskStrokeSession({
    config,
    targetLayerId: targetLayer.id,
    frameId: frame.id,
    localMatrixInverse,
    localBrushSize,
    maskOrigin,
    maskW,
    maskH,
    records,
    initialIsRestore: isRestore,
  });

  // Materialize the session-start op's canvases, load existing record content
  // (with per-record async fallback) and dispatch the initial live preview.
  // The session owns this because mid-stroke Tab flips use the same path to
  // materialize lazily.
  session.bootstrap(e);

  return session;
}

// ─── Helper Functions ──────────────────────────────────────────────────────────

/**
 * Reads mask brush configuration from plugin state.
 *
 * Translates the PERSISTED CraftDrawer panel keys (`craftConfig.brushSize` etc.)
 * into the tool-neutral `StrokeConfig` field names. Mask edits paint pure white
 * into a non-destructive mask, so no brush colour is sourced.
 */
function readBrushConfig(e: InteractionEvent, frame: Frame): StrokeConfig {
  const craftConfig = e.state.pluginConfig[CraftDrawerAPI.configKey] || {};

  // HARD mask edge: straight from the panel's AA toggle. The panel keeps the
  // AA ⇔ hardness two-way binding (AA on forces hardness to 100, hardness < 100
  // forces AA off), so no extra hardness gate is needed here — AA off is a
  // deliberate user choice at ANY hardness. Shared by BOTH families (restore
  // and eraser read the same toggle — zero special-casing).
  const eraserAntiAliased = craftConfig.eraserAntiAliased as boolean | undefined;

  return {
    size: (craftConfig.brushSize as number) ?? DEFAULT_BRUSH_SIZE,
    opacity: (craftConfig.brushOpacity as number) ?? 100,
    hardness: (craftConfig.brushHardness as number) ?? 80,
    hard: eraserAntiAliased === false,
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
