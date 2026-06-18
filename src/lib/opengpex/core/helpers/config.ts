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
    POPOVER: 5000,        // Tooltip, Popover, Dropdown (requires Portal)
    OVERLAY: 4000,        // Global overlay plugins
    MODAL: 6000,          // Modal dialogs and warnings
  }
};

/** Agreed stacking value for the Host layer is 10 */
export const HOST_LAYER_ORDER = 10;

/** Industrial-grade rendering safety threshold: 144MP (approx. 12000x12000). Exceeding this value forces tiled rendering to prevent OOM */
export const MAX_SAFE_EXPORT_PIXELS = 144_000_000;

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
