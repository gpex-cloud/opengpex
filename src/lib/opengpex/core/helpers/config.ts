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
 * Segmented z-index matrix — the single source of truth for every z-index that
 * competes across stacking contexts (see gpex-assets arch/21 spec).
 *
 * Model: SEGMENT × 1000 span, LAYER × 100 step, COMPONENT × 10 step.
 *  - A segment is an absolute isolation domain: no member of a lower segment
 *    can ever paint above a member of a higher segment, no matter how its
 *    internals are arranged. Offsets that cross a layer/segment boundary are
 *    forbidden; add a named seat instead.
 *  - Islands (stacking-context containers such as portal roots) expose exactly
 *    one segment seat to the outside; their interior values are component-level
 *    (×10) free space and never compare with the outside.
 *  - Segment order anchors: notifications above dialogs; canvas overlays below
 *    dialogs; fullscreen canvas overlays below dialogs but above popups;
 *    popovers/tooltips inside dialogs above every dialog; blocking prompts
 *    and notification HUDs above all of them; context menu above modals;
 *    the colour-sampler capture above everything.
 */
export const EDITOR_Z_INDEX = {
  // Segment 0 · STAGE (0–999) — canvas interior, below every UI band
  STAGE: {
    BACKDROP: 0,          // L0: canvas backdrop
    CONTENT: 100,         // L1: LayerStack (CanvasStage artboard wrapper)
    GIZMOS: 200,          // L2: STAGE_GIZMOS slot — guide lines, anchor points (island inside the transform stage)
    OVERLAY: 300,         // L3: STAGE_OVERLAY slot — marching ants, brush canvas surface, text editor
    GUIDES: 310,          // L3 component step: SmartGuides snap lines (one step above the ants, DOM order independent)
    FEEDBACK: 400,        // L4: DeltaLabel displacement/angle chip
    PLUGIN_CANVAS: 700,   // L7: 700–999 canvas plugin autonomy band (former DEVELOPER_ZONE)
  },
  // Segment 1 · CHROME (1000–1999) — workspace skeleton
  CHROME: {
    DRAWER_BAR: 1000,     // L0: side drawers
    VIEWPORT_HUD: 1100,   // L1: ViewportHUD corner slots (TL/TR/BL/BR)
    DOCK: 1110,           // L1 component step: global DOCK slot
    FLOATING_MENU: 1200,  // L2: floating ToolMenu, ExtendButton, OptionBar top bar
    BOOT_OVERLAY: 1400,   // L4: boot FancyOverlay — covers the workspace, below every floating layer
  },
  // Segment 2 · POPUP (2000–2999) — portal-hosted floating layers
  POPUP: {
    PORTAL_ROOT: 2000,    // L0: popup portal root (the only seat the island exposes)
    POPOVER: 2010,        // island interior: Popover default
    TOOLTIP: 2020,        // island interior: Tooltip default — one step above popovers
  },
  // Segment 3 · FULLSCREEN (3000–3999) — canvas fullscreen overlays, above
  // every popup but below dialogs (a dialog must cover the brush)
  FULLSCREEN: {
    OVERLAY: 3000,        // L0: brush / eraser / mosaic cursor surfaces
  },
  // Segment 4 · MODAL (4000–4999) — dialogs and their floating children,
  // with the system-to-user message family on top
  MODAL: {
    PORTAL_ROOT: 4000,    // L0: modal portal root (island seat)
    ONBOARDING: 4010,     // island interior: onboarding guide — above popups, below dialogs
    DIALOG: 4020,         // island interior: NewDocument / LoginModal / ReleaseGuideCard
    POPOVER: 4030,        // island interior: Popover opened from inside a dialog (forModal)
    TOOLTIP: 4040,        // island interior: Tooltip shown inside a dialog (forModal)
    PROMPT: 4800,         // L8: blocking system prompts — FancyChoice / FancyConfirm (no forModal children)
    NOTIFICATION: 4810,   // L8 component step: notification HUDs (GlobalUI + FileLoader) — above prompts
  },
  // Segment 5 · WINDOW (5000–5999) — window surfaces above modals
  WINDOW: {
    PORTAL_ROOT: 5000,    // L0: window portal root (context menu island seat)
    CONTEXT_MENU: 5010,   // island interior: ActionDropdown menus
    BRANCH_FLY: 5200,     // L2: branch fly animation
  },
  // Segment 6 · TOP (6000–6999) — must beat everything conventional
  TOP: {
    FULLSCREEN_CAPTURE: 6900, // L9: colour-sampler fullscreen capture — absolute top
  },
} as const;

/** Agreed stacking value for the Host layer is 10 */
export const HOST_LAYER_ORDER = 10;

/**
 * Performance monitoring switch.
 * When enabled, CanvasStage and WebGpuEngine emit console.warn diagnostics
 * whenever a frame or flush exceeds the 16 ms budget. Disabling this avoids
 * performance.now() calls and counter increments on every frame.
 *
 * Controlled via .env: NEXT_PUBLIC_GPEX_PERF_MON=true to enable.
 */
export const PERF_MON = process.env.NEXT_PUBLIC_GPEX_PERF_MON === 'true';

/**
 * Sub-pixel seam prevention switch.
 *   - SEAM_EXPAND_FRAGMENT: Controls fragment visibleShape outward expansion
 */
export const SEAM_EXPAND_FRAGMENT = true;

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
 * Off-screen calculation (background Worker) driver engine switch
 * - 'canvas2d': Stable and mature DOM API drawing.
 * - 'wasm': (Experimental) Native hardware acceleration for compute-heavy tasks (e.g. masks, filters).
 * 
 * Note: This switch only affects background off-screen blending and rendering calculations.
 */
export const WORKER_RENDER_ENGINE: 'canvas2d' | 'wasm' = 'canvas2d';

/** Whether in cloud service mode. Set to true for SaaS production environments, false for local/dev mode */
export const IS_CLOUD_MODE = process.env.NEXT_PUBLIC_GPEX_CLOUD_MODE === 'true' || process.env.GPEX_CLOUD_MODE === 'true';

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
    // [-180, 180] (see the `SLIDERS` table in basic.tsx). 200° folds to -160° via
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
