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
 * types.d.ts — Minimal type definitions for wasm-vips.
 *
 * These types cover the subset of the wasm-vips API used by VipsBackend
 * and FileIoHandler. They prevent `any` usage per architecture invariant §六.9.
 *
 * Reference: https://github.com/nickmccurdy/wasm-vips
 */

/**
 * Represents a libvips image object loaded in WASM memory.
 * All image operations return a new VipsImage (immutable pipeline).
 */
export interface VipsImage {
  readonly width: number;
  readonly height: number;
  readonly bands: number;
  readonly format: string;
  readonly interpretation: string;

  hasAlpha(): boolean;

  /**
   * Extract one or more bands starting at `band`.
   * @param band - Zero-based band index
   * @param opts - Optional: `n` = number of bands to extract
   */
  extractBand(band: number, opts?: { n?: number }): VipsImage;

  /**
   * Join bands from another image (or constant) to produce a new image.
   */
  bandjoin(other: VipsImage | VipsImage[] | number | number[]): VipsImage;

  /**
   * Composite overlay image(s) onto this image using blend mode(s).
   * @param overlay - Image or array of images to composite on top
   * @param mode - VipsBlendMode enum value or array of values
   * @param opts - Optional compositing parameters (x/y can be arrays for multiple overlays)
   */
  composite(overlay: VipsImage | VipsImage[], mode: number | number[], opts?: { x?: number | number[]; y?: number | number[] }): VipsImage;

  /**
   * Cast the image to a new pixel format.
   * @param format - Target format: 'float', 'double', 'ushort', 'uchar', etc.
   */
  cast(format: string): VipsImage;

  /**
   * Multiply each pixel by a factor (image or scalar).
   */
  multiply(factor: VipsImage | number): VipsImage;

  /**
   * Divide each pixel by a divisor (scalar).
   */
  divide(factor: number): VipsImage;

  /**
   * Apply linear transform: out = in * a + b
   */
  linear(a: number | number[], b: number | number[]): VipsImage;

  /**
   * Add a constant or image to this image.
   */
  add(value: VipsImage | number): VipsImage;

  /**
   * Remainder (modulo) operation.
   */
  remainder(divisor: number): VipsImage;

  /**
   * Convert the image to a different color space.
   * @param space - Target color space: 'srgb', 'lch', 'lab', 'rgb16', etc.
   */
  colourspace(space: string): VipsImage;

  /**
   * Transform image from one ICC profile to another using Little CMS.
   * @param outputProfile - Path to target ICC profile file (in emscripten virtual FS)
   * @param opts - Options: inputProfile (built-in name like 'srgb'), intent ('perceptual'|'relative'|'saturation'|'absolute')
   */
  iccTransform(outputProfile: string, opts?: { input_profile?: string; intent?: string }): VipsImage;

  /**
   * Apply Gaussian blur.
   * @param sigma - Standard deviation of the Gaussian
   */
  gaussblur(sigma: number): VipsImage;

  /**
   * Create a new image with the same dimensions but filled with the given pixel.
   */
  newFromImage(pixel: number[]): VipsImage;

  /**
   * Embed this image in a larger canvas with given offset and dimensions.
   */
  embed(x: number, y: number, width: number, height: number, opts?: { extend?: string }): VipsImage;

  /**
   * Extract a rectangular region from the image.
   */
  extractArea(left: number, top: number, width: number, height: number): VipsImage;

  /**
   * Resize the image.
   */
  resize(scale: number, opts?: { vscale?: number; kernel?: string }): VipsImage;

  /**
   * Get a metadata field value from the image header.
   * @param field - Metadata field name (e.g. 'n-pages', 'icc-profile-data')
   */
  get(field: string): unknown;

  /**
   * Set a metadata field value on the image header.
   * @param field - Metadata field name
   * @param value - Value to set
   */
  set(field: string, value: unknown): void;

  /**
   * Write the image to a buffer in the specified format.
   * @param suffix - Output format suffix: '.tiff', '.png', '.raw', etc.
   * @param opts - Format-specific write options
   */
  writeToBuffer(suffix: string, opts?: Record<string, unknown>): Uint8Array;

  /**
   * Write the image to raw memory (unformatted pixel data).
   */
  writeToMemory(): Uint8Array;

  /**
   * Release WASM-side memory. Must be called when done with this image.
   */
  delete(): void;
}

/**
 * Top-level vips instance returned by the Vips() factory function.
 */
export interface VipsInstance {
  Image: {
    /**
     * Create a black image of given dimensions.
     * @param w - Width
     * @param h - Height
     * @param opts - Optional: `bands` = number of bands (default 1)
     */
    black(w: number, h: number, opts?: { bands?: number }): VipsImage;

    /**
     * Create an image from raw memory (pixel data).
     * @param data - Raw pixel data
     * @param width - Image width
     * @param height - Image height
     * @param bands - Number of bands (channels)
     * @param format - Pixel format: 'uchar', 'ushort', 'float', etc.
     */
    newFromMemory(
      data: Uint8Array | ArrayBuffer,
      width: number,
      height: number,
      bands: number,
      format: string,
    ): VipsImage;

    /**
     * Load an image from an in-memory buffer (TIFF, PNG, JPEG, etc.).
     * @param data - File bytes
     * @param options - Optional format hint string (e.g. '' for auto-detect)
     * @param loadOpts - Additional loader options
     */
    newFromBuffer(
      data: Uint8Array | ArrayBuffer,
      options?: string,
      loadOpts?: Record<string, unknown>,
    ): VipsImage;
  };

  /**
   * Blend mode enumeration for composite operations.
   * Maps blend mode names to numeric IDs used by vips_composite.
   */
  BlendMode: Record<string, number>;

  /**
   * Emscripten virtual file system.
   * Used for writing temporary ICC profiles that vips can reference by path.
   */
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    unlink(path: string): void;
  };
}
