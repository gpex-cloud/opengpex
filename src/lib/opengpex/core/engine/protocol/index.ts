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
 * protocol/ barrel export — all cross-thread protocol types.
 */

export type {
  MatrixData,
  WorldMatrix,
  LayerDescriptor,
  BitmapMaskDescriptor,
} from './descriptors';
export { asWorldMatrix, translateToRoi } from './descriptors';

export type {
  ResampleJob,
  DecodeJob,
  EnsureAssetJob,
  Job,
} from './jobs';

export type { PixelResultData } from './results';

// ── (removed in v2) DisplayTransform protocol layer ──
//
// `DisplayTransform.ts` was a post-composite "protocol stage" whose only live job
// was channel-view isolation, expressed as a string enum that diverged from the
// engine's own channel mask (the root of the channel-view regression). Under the
// WebGPU architecture the display channel lives on `Scene.display.channelMask`
// (`core/gpu/scene/Scene.ts`) as a 4-bit visibility mask applied in the view pass;
// its "future" roles (ICC/soft-proof/HDR) are already served by `Scene.display`
// + the in-shader colour pipeline, not a separate protocol layer. The UI fold
// helper moved to `plugins/base/drawers/LayersDrawer/components/channelMask.ts`
// and the signal key to `Scene.ts`.

// ── (removed in v2) IFilter contract ──
//
// `IFilter.ts` described the CPU/Canvas2D filter runtime: a descriptor union with
// per-op arms, the classification/colour-hint helpers, and the backend interface.
// All of it is superseded by the declarative `AdjustmentDesc` / `FilterDesc` shapes
// in `core/gpu/scene/Scene.ts`, evaluated by `adjust.wgsl` and `FilterPass`.
// The DATA types it also held (curve points / levels config / channel
// mixer matrix) live in `core/types/models.ts`, which is where the persisted
// `Layer.curves` / `Layer.levels` / `Layer.channelMix` already pointed — so nothing
// was lost, one duplicate declaration was removed.
