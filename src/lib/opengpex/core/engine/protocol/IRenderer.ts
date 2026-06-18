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
   * Initializes frame drawing, clears canvas 
   */
  beginFrame(dim: Dimensions): void;

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
