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

export const EDITOR_Z_INDEX = {
  // Stage (Inside Artboard) - Overlapping conflict zone
  STAGE: {
    BACKDROP: 0,
    CONTENT: 100,      // Starting level of layer (LayerStack)
    GIZMOS: 1000,       // Basic interactive entities (guide lines, anchor points)
    SYSTEM_TOOLS: 2000, // Core tools (selection box, crop box)
    DEVELOPER_ZONE: 3000, // Third-party safety zone
  },
  // Workspace (Global UI) - Layout tiling zone
  UI: {
    WORKSPACE_BASE: 2000, // Sidebar, top bar, action bar
    OVERLAY: 4000,        // Global overlay plugins
    POPOVER: 5000,        // Popover, Dropdown (requires Portal)
    MODAL: 6000,          // Modal dialogs and warnings
    TOOLTIP: 10100,       // Tooltip — must float above Popover (default 9999)
  }
};

/** Agreed stacking value for the Host layer is 10 */
export const HOST_LAYER_ORDER = 10;

/**
 * Performance monitoring switch.
 * When enabled, CanvasStage and Canvas2dEngine emit console.warn diagnostics
 * whenever a frame or flush exceeds the 16 ms budget. Disabling this avoids
 * performance.now() calls and counter increments on every frame.
 *
 * Controlled via .env: NEXT_PUBLIC_GPEX_PERF_MON=true to enable.
 */
export const PERF_MON = process.env.NEXT_PUBLIC_GPEX_PERF_MON === 'true';

/** Industrial-grade rendering safety threshold: 144MP (approx. 12000x12000). Exceeding this value forces tiled rendering to prevent OOM */
export const MAX_SAFE_EXPORT_PIXELS = 144_000_000;

/**
 * Realtime filter threshold: 1M pixels (approx. 1000×1000).
 * 
 * During interaction (slider drag), images below this threshold use main-thread
 * LUT rendering for instant feedback. Larger images show original source during
 * drag and apply full-res filter on mouseUp via Worker.
 * 
 * Rationale: Main-thread LUT ≈ 10ms/megapixel; 60fps frame budget = 16ms.
 */
export const MAX_REALTIME_FILTER_PIXELS = 1_000_000;

/**
 * Layer auxiliary role configuration (Composite Entity Architecture)
 * Uses dictionary to drive behavior, avoiding hardcoding
 */
export const LAYER_ROLE_CONFIGS = {
  exchange: { label: 'Exchange', order: 30, follow: true },
} as const;

/**
 * Frontend viewport (CanvasStage) driver engine switch
 * - 'canvas2d': Stable, most compatible 2D API drawing (currently default).
 * - 'webgl': (Experimental) High-performance native GPU rendering, suitable for rendering large-scale artboards with 100k+ nodes.
 */
export const STAGE_RENDER_ENGINE: 'canvas2d' | 'webgl' = 'canvas2d';

/**
 * Off-screen calculation (background Worker) driver engine switch
 * - 'canvas2d': Stable and mature DOM API drawing.
 * - 'wasm': (Experimental) Native hardware acceleration for compute-heavy tasks (e.g. masks, filters).
 * 
 * Note: This switch only affects background off-screen blending and rendering calculations.
 */
export const WORKER_RENDER_ENGINE: 'canvas2d' | 'wasm' = 'canvas2d';

/** Whether in cloud service mode. Set to true for SaaS production environments, false for local/dev mode */
export const IS_CLOUD_MODE = process.env.NEXT_PUBLIC_GPEX_CLOUD_MODE === 'true' || process.env.GPEX_CLOUD_MODE === 'true';

/**
 * Text layer editor padding configuration (px)
 * Simultaneously affects: CSS padding of contenteditable in edit mode and the start offset of fillText during rasterization.
 * Keeping both consistent avoids visual jumping between edit and non-edit states.
 */
export const TEXT_LAYER_PADDING = { x: 4, y: 2 } as const;

/** Physical directory for persisted plugins (supports local adaptive relative path fallback), kept as a pure string, excluding Node's native path module to prevent browser-side compile crashes */
export const PERSISTENT_PLUGINS_DIR = 'data/plugins/user';

/** GitHub repository URL — single source of truth for all in-app links */
export const GITHUB_REPO_URL = 'https://github.com/gpex-cloud/opengpex';

/** -----------------------------------------------------------------*/
/** Export Estimation -----------------------------------------------*/
/** -----------------------------------------------------------------*/

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
/** Adjustments / Filter Presets ------------------------------------*/
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
    // [Hue signed range] Basic panel now models Hue as bidirectional
    // [-180, 180] (see basic.tsx §SLIDERS). 200° folds to -160° via
    // hue-rotate's modulo-360 semantics — same visual result, but now
    // the slider thumb lands inside its declared range.
    values: { brightness: 100, contrast: 105, saturation: 95, hueRotate: -160, blur: 0 }
  },
  {
    id: 'vintage',
    label: 'Vintage',
    values: { brightness: 110, contrast: 85, saturation: 80, hueRotate: 30, blur: 0.5 }
  },
];
