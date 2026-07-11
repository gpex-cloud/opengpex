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

import { Layer, IMatrix3x3, ClipDescriptor, Dimensions, Rect } from '@opengpex/editor/core/types';
import { AssetService } from '@opengpex/editor/core/types';

export interface DrawLayerOptions {
  matrix?: IMatrix3x3 | { a: number; b: number; c: number; d: number; tx: number; ty: number };
  opacity?: number;
  drawRect?: Rect;
  clipSequence?: ClipDescriptor[];
  bitmapMaskOverride?: { maskId: string; source: CanvasImageSource };     // New: fast-track override
  width?: number;
  height?: number;
  imageSmoothingQuality?: 'low' | 'high';
  isExporting?: boolean;
  imageOverride?: CanvasImageSource;
  /**
   * [Filter Fast-Track §2.1] True while user is dragging a slider/control.
   * During interaction, the engine bypasses AsyncFilterCache's Worker RPC
   * for small images (pixels ≤ MAX_REALTIME_FILTER_PIXELS) and shows the
   * unfiltered source for large images to maintain 60fps responsiveness.
   * @see 20260711_filter_fast_track_extension.md
   */
  isInteracting?: boolean;
}

export interface RenderLayerCommand {
  type: 'layer';
  layer: Layer;
  options: DrawLayerOptions;
}

export type RenderCommand = RenderLayerCommand;

/**
 * Abstract rendering backend interface (WASM-Ready)
 * Does not depend on any specific DOM or CanvasRenderingContext2D API.
 */
export interface IRenderer {
  /** 
   * Initializes frame drawing, clears canvas.
   * @param dim - The logical frame dimensions (for internal tracking)
   * @param artboardClip - Optional clip rect (in physical pixel space) that
   *   restricts all subsequent rendering to the artboard boundary. When
   *   provided, pixels outside this rect are never drawn — this ensures
   *   layers that extend beyond the canvas are visually hidden without
   *   destructively modifying their data.
   */
  beginFrame(dim: Dimensions, artboardClip?: Rect): void;

  /** 
   * Pushes instruction to rendering queue (Display List mode)
   * This enables cross-boundary (JS <-> WASM) communication to be batched, avoiding frequent bridge calls.
   */
  pushCommand(cmd: RenderCommand): void;

  /** 
   * Immediately executes all commands in the queue 
   */
  flush(assetService?: AssetService): void;

  /**
   * (Legacy compatibility) Directly draws single layer, bypassing command queue
   */
  drawLayerDirect(layer: Layer, options: DrawLayerOptions, assetService?: AssetService): void;
}
