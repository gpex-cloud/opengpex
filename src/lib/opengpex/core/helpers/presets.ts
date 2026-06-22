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



/** -----------------------------------------------------------------*/
/** Viewport Settings -----------------------------------------------*/
/** -----------------------------------------------------------------*/
// [REFACTOR-2026-06-22] `VIEWPORT_FIT_FACTOR` (0.90) was removed:
// it duplicated the role of `padding` (numeric breathing room) inside
// `getFitCamera`, causing fit-paths to apply both an 80px padding AND
// an extra 10% shrink — wasting space on large screens, cramping small.
// The single source of breathing room is now `padding` passed via
// `CameraCenterOptions`.

/**
 * Default fit-camera padding (in viewport pixels).
 *
 * Geometric breathing room between the canvas and the safe-area boundary
 * during any "fit" computation (`getFitCamera`). This is **orthogonal** to
 * `offsetXxx` (which represents chrome occupancy from LayoutProvider slots).
 *
 * Adjust here to globally tighten/loosen fit results across:
 * - `viewport.fit` / `viewport.actualSize` (translate.ts)
 * - `frame.create.trunk` / `branch` / `revert` (create.ts)
 * - `frame.resize.resizeCanvas` / `resample` (resize.ts)
 * - `useCameraInit` (auto-fit)
 */
export const VIEWPORT_FIT_PADDING = 40;


/**
 * Checkerboard background configuration
 */
export const BACKDROP_GRID_CONFIG = {
  /** Size of a single checkerboard grid cell (unit: pixels) */
  GRID_SIZE: 8,
  /** Whole cycle size of the checkerboard repeating pattern (must equal GRID_SIZE * 2) */
  PATTERN_SIZE: 16,
};


/** -----------------------------------------------------------------*/
/** Export Settings -------------------------------------------------*/
/** -----------------------------------------------------------------*/

/**
 * Default canvas export quality (0.0 to 1.0).
 * Used for JPEG and WEBP formats.
 */
export const DEFAULT_EXPORT_QUALITY = 0.92;

/**
 * Estimation Multipliers (Smart File Size Estimation).
 * These help predict the final file size without rendering the image.
 */
export const ESTIMATION_PRESETS = {
  // Typical reduction ratio from PNG to Lossy (WEBP/JPG)
  LOSSLESS_TO_LOSSY_RATIO: 0.15,

  // Typical expansion ratio from Lossy to PNG
  LOSSY_TO_LOSSLESS_RATIO: 6.0,

  // Minimum Bytes Per Pixel (BPP) for safety
  MIN_BPP_LOSSLESS: 1.0,
  MIN_BPP_LOSSY: 0.15,
};

/** -----------------------------------------------------------------*/
/** AI Image Model Keywords -----------------------------------------*/
/** -----------------------------------------------------------------*/

/**
 * Keyword list of known image generation models.
 * Used to filter out image models from the complete model list returned by the /v1/models endpoint.
 * To support a new model, simply add the keyword here (case-insensitive).
 */
export const IMAGE_MODEL_KEYWORDS: string[] = [
  // OpenAI
  'dall-e',
  'gpt-image',
  // Stability AI
  'stable-diffusion',
  'stable_diffusion',
  'sdxl',
  'sd3',
  'sd-',
  'ssd',
  // Black Forest Labs
  'flux',
  // Midjourney
  'midjourney',
  // Google
  'imagen',
  // Kandinsky
  'kandinsky',
  // Playground
  'playground',
  // Community / Fine-tunes
  'dreamshaper',
  'realvis',
  'deliberate',
  'proteus',
  'juggernaut',
  'animagine',
  'waifu',
  'anything-v',
  'counterfeit',
  'rev-animated',
  'openjourney',
  // Generic keywords
  'txt2img',
  'img2img',
  'image-gen',
  'image_gen',
  'art-',
  'paint-',
  'draw-',
  'creative-',
  'qwen3-vl-',
  'qwen-image'
];

/** -----------------------------------------------------------------*/
/** Adjustments Settings --------------------------------------------*/
/** -----------------------------------------------------------------*/

/**
 * Professional Adjustment Presets.
 */
export const FILTER_PRESETS = [
  {
    id: 'original',
    label: 'Original',
    values: { brightness: 100, contrast: 100, saturation: 100, hueRotate: 0, blur: 0 }
  },
  {
    id: 'vivid',
    label: 'Vivid',
    values: { brightness: 110, contrast: 120, saturation: 135, hueRotate: 0, blur: 0 }
  },
  {
    id: 'noir',
    label: 'Noir',
    values: { brightness: 105, contrast: 130, saturation: 0, hueRotate: 0, blur: 0 }
  },
  {
    id: 'dreamy',
    label: 'Dreamy',
    values: { brightness: 115, contrast: 90, saturation: 110, hueRotate: 0, blur: 1.5 }
  },
  {
    id: 'warm',
    label: 'Warm',
    values: { brightness: 105, contrast: 100, saturation: 115, hueRotate: 15, blur: 0 }
  },
  {
    id: 'cold',
    label: 'Cold',
    values: { brightness: 100, contrast: 105, saturation: 95, hueRotate: 200, blur: 0 }
  },
  {
    id: 'vintage',
    label: 'Vintage',
    values: { brightness: 110, contrast: 85, saturation: 80, hueRotate: 30, blur: 0.5 }
  },
];
