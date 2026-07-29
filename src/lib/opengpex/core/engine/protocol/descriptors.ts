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
 * descriptors.ts — Serializable layer and matrix descriptors for cross-thread transfer.
 *
 * Design rules:
 * 1. All fields must be JSON-safe (structured-clone compatible).
 * 2. No DOM refs, no functions, no closures.
 * 3. WorldMatrix is the ONLY branded matrix type — see architecture doc §五.
 */

import type {
  Layer,
  VectorMask,
  BitmapMask,
  AdjustmentState,
  CurvesState,
  LevelsState,
  ChannelMixState,
  ColorBalanceState,
  LayerBlendMode,
} from '@opengpex/editor/core/types';

// ─── Matrix Types ───

export interface MatrixData {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

declare const __brand: unique symbol;

/**
 * WorldMatrix — branded type used to prevent coordinate-space confusion.
 * Passed through LayerDescriptor → Job → Handler, providing real type-safety.
 *
 * Note: RoiMatrix/LocalMatrix are NOT branded — they are short-lived
 * local temporaries that don't cross function signature boundaries,
 * so branding provides minimal protective value.
 */
export type WorldMatrix = MatrixData & { readonly [__brand]: 'world' };

export function asWorldMatrix(m: MatrixData): WorldMatrix {
  return m as WorldMatrix;
}

/**
 * Translate a world matrix to ROI coordinate system.
 * Returns plain MatrixData (unbranded).
 * Used only inside Canvas2dBackend.drawLayer.
 */
export function translateToRoi(
  world: WorldMatrix,
  roiOrigin: { x: number; y: number },
): MatrixData {
  return { ...world, tx: world.tx - roiOrigin.x, ty: world.ty - roiOrigin.y };
}

// ─── LayerDescriptor ───

/**
 * Serializable snapshot of a Layer, suitable for postMessage transfer.
 * Built by `buildDescriptor()` (in Dispatch layer) from the live Layer + AssetService.
 */
export interface LayerDescriptor {
  type: Layer['type'];
  assetId: Layer['assetId'];
  metadata: Layer['metadata'];
  textData: Layer['textData'];
  bounding: Layer['bounding'];
  visibleShape: Layer['visibleShape'];
  vectorMasks: VectorMask[] | undefined;
  bitmapMasks: BitmapMask[] | undefined;
  opacity: number;
  blendMode: LayerBlendMode;
  fill: number | undefined;
  adjustments: AdjustmentState | undefined;
  curves: CurvesState | undefined;
  levels: LevelsState | undefined;
  channelMix: ChannelMixState | undefined;
  colorBalance: ColorBalanceState | undefined;
  /** Worker uses this hash to retrieve bitmap from WorkerCache (extracted from AssetService by buildDescriptor) */
  hash: string;
  worldMatrix: WorldMatrix;
  dprScale: number;
}

// ─── BitmapMaskDescriptor ───

export interface BitmapMaskDescriptor {
  id: string;
  hash: string;
  enabled: boolean;
  inverted: boolean;
}
