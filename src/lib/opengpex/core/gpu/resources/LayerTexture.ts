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
 * LayerTexture.ts — Resident layer texture metadata and view wrapper (spec §6.1, §6.3).
 *
 * Encapsulates a resident `GPUTexture` alongside its actual content pixel
 * dimensions and its allocated physical dimensions. If allocated via a bucketed
 * pool, `width <= allocatedWidth` and `height <= allocatedHeight`, so UV
 * coordinates are scaled by `(maxU, maxV)`.
 *
 * @module core/gpu/resources/LayerTexture
 */

export class LayerTexture {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly width: number;
  readonly height: number;
  readonly allocatedWidth: number;
  readonly allocatedHeight: number;
  readonly format: GPUTextureFormat;
  private isDestroyed = false;

  constructor(options: {
    texture: GPUTexture;
    view?: GPUTextureView;
    width: number;
    height: number;
    allocatedWidth?: number;
    allocatedHeight?: number;
    format: GPUTextureFormat;
  }) {
    this.texture = options.texture;
    this.width = options.width;
    this.height = options.height;
    this.allocatedWidth = options.allocatedWidth ?? options.width;
    this.allocatedHeight = options.allocatedHeight ?? options.height;
    this.format = options.format;
    this.view = options.view ?? options.texture.createView();
  }

  /** Normalised right-edge UV coordinate (<= 1.0). */
  get maxU(): number {
    return this.allocatedWidth > 0 ? this.width / this.allocatedWidth : 1.0;
  }

  /** Normalised bottom-edge UV coordinate (<= 1.0). */
  get maxV(): number {
    return this.allocatedHeight > 0 ? this.height / this.allocatedHeight : 1.0;
  }

  destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.texture.destroy();
  }
}
