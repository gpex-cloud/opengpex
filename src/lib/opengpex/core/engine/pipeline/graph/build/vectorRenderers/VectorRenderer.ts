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
 * VectorRenderer.ts — The vector spine's render-strategy contract (Layer B).
 *
 * A `VectorRenderer` turns an engine-neutral vector source (`VectorParams`, no
 * business model) into coverage/colour inside a pre-cleared offscreen transient.
 * The RenderGraph owns the whole SPINE around it — transient allocation (incl.
 * exportScale supersampling), the architecture-B tail (the transient is consumed
 * downstream as an ordinary straight-alpha raster by `drawLayer`), the shared
 * `runFilterChain`, and the STRAIGHT-alpha / working-gamut-linear contract — and
 * dispatches to the strategy named by `source.renderer`.
 *
 * Two strategies are engine built-ins (static union, no runtime registry):
 *   - `SdfRenderer`    — fragment-shader analytic SDF (rounded_rect/ellipse/arrow).
 *   - `StrokeRenderer` — compute-extruded ribbon mesh (logic brush; empty slot).
 *
 * OUTPUT CONTRACT (load-bearing): a strategy MUST write STRAIGHT (un-premultiplied)
 * alpha in WORKING-gamut (Display-P3) linear light, with REPLACE blend over the
 * caller-cleared transient, and apply NEITHER `layer.opacity` NOR mask — those are
 * the downstream `drawLayer`'s job, exactly as for any raster source.
 *
 * @module core/gpu/graph/build/vectorRenderers/VectorRenderer
 */

import type { PipelineCache } from '@opengpex/editor/core/engine/gpu/resources/PipelineCache';
import type { BufferRing } from '@opengpex/editor/core/engine/gpu/resources/BufferRing';
import type { VectorParams } from '../../../scene/Scene';

/** GPU resources the spine hands every strategy. Shape-agnostic. */
export interface VectorRenderContext {
  readonly device: GPUDevice;
  readonly pipelineCache: PipelineCache;
  readonly bufferRing: BufferRing;
  readonly targetFormat: GPUTextureFormat;
  /**
   * [PERF_MON] Optional per-pass GPU timer hook. A strategy that records its OWN
   * pass (e.g. StrokeRenderer's compute prepass) spreads the result into that pass
   * descriptor's `timestampWrites` so its GPU exec time is attributed separately.
   * Undefined when timing is off / unsupported — the strategy then omits the field.
   */
  readonly timestamp?: (label: string) => GPUComputePassTimestampWrites | undefined;
}

/** Per-draw inputs. `backdrop` is fed only when the strategy sets `needsBackdrop`. */
export interface VectorRenderArgs {
  readonly params: VectorParams;
  readonly backdrop?: GPUTextureView;
}

export interface VectorRenderer {
  /**
   * OPTIONAL compute prepass, encoded onto the surrounding command encoder BEFORE the
   * source's render pass opens. WebGPU forbids beginning a compute pass while a render
   * pass is active, so a strategy that must run compute (e.g. StrokeRenderer extruding
   * a ribbon mesh from a trajectory) records it here; the spine calls this immediately
   * before `beginRenderPass`. Same-source, same-encoder ordering guarantees the compute
   * writes are visible to the subsequent `render` draw. A pure fragment strategy
   * (`SdfRenderer`) leaves this unset.
   */
  encodePrepass?(encoder: GPUCommandEncoder, ctx: VectorRenderContext, args: VectorRenderArgs): void;

  /**
   * Draw the vector source into the ACTIVE render pass whose colour attachment is
   * the source's transient (already cleared by the caller). The caller owns the
   * render pass lifetime so the draw can batch into the surrounding encoder.
   */
  render(pass: GPURenderPassEncoder, ctx: VectorRenderContext, args: VectorRenderArgs): void;

  /**
   * Whether the spine must feed an already-composited backdrop texture into
   * `render` (smudge / behind-blur brush profiles). `SdfRenderer` is always false;
   * a pure coverage/colour strategy leaves this unset.
   */
  readonly needsBackdrop?: boolean;
}
