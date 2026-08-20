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

import { EditorPlugin } from "@opengpex/editor/core/types";
import { Cpu } from "lucide-react";
import { AIToolsDrawerContent } from "./components";
import { AIToolsSettings } from "./settings";
import { BG_REMOVAL_COMMANDS } from "./bgremover/commands";
import { SEG_COMMANDS } from "./segmentation/commands";
import { UPSCALE_COMMANDS } from "./upscaler/commands";
import { INPAINT_ERASER_COMMANDS } from "./inpaint/eraser/commands";
import { AIToolsIcon } from "./icon";

import * as P from "./protocols";
import { MODEL_TYPE_KEY as BGREMOVER_KEY, DEFAULT_BG_REMOVAL_CONFIG } from './bgremover/protocols';
import { MODEL_TYPE_KEY as UPSCALER_KEY, DEFAULT_UPSCALE_CONFIG } from './upscaler/protocols';
import { MODEL_TYPE_KEY as SEG_KEY, DEFAULT_SEG_CONFIG } from './segmentation/protocols';
import { MODEL_TYPE_KEY as ERASER_KEY, DEFAULT_INPAINT_ERASER_CONFIG } from './inpaint/eraser/protocols';

/**
 * AIToolsDrawer Plugin — Unified AI Inference Tools
 *
 * Provides multiple AI tools running entirely client-side (WebGPU → WASM fallback):
 *   - Background Removal (RMBG, InSPyReNet)
 *   - Image Upscaling (Real-ESRGAN, AnimeSharp)
 *   - SAM Segmentation (SAM 2.1 Tiny)
 *   - Smart Eraser / Inpainting (LaMa)
 *
 * Architecture:
 *   - Drawer plugin in SIDE_BAR slot (order 2300)
 *   - Worker-based inference pipeline (persistent singletons, Mode B)
 *   - Cross-tool GPU mutex prevents WebGPU contention
 *   - Each tool has: store → client → worker → protocols
 *   - Shared infrastructure: createAIToolStore, createWorkerClient, runInferenceCommand
 */
export const plugin: EditorPlugin = {
  // --- 1. Identity ---
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "AI Tools",
    version: "2.0.0",
    description:
      "One-click AI background removal with multiple model support (RMBG, BiRefNet, InSPyReNet). Runs entirely in-browser via WebGPU/WASM — no server needed.",
    author: P.PLUGIN_AUTHOR,
    category: "drawers",
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },

  // --- 2. UI Entry ---
  icon: <AIToolsIcon />,
  slot: "SIDE_BAR",
  show: 'frame-required',

  order: 2300,

  // --- 3. Core Implementation ---
  component: AIToolsDrawerContent,

  // --- 4. Auto-Reveal ---
  autoReveal: {
    when: (state) => {
      // Reveal when in clip mode with SAM tool active.
      // Uses sticky mode (collapseWhenFalse: false) — drawer auto-opens
      // but never auto-closes. Manual close is handled in components.tsx
      // to avoid false-edge bugs when the user switches tabs.
      if (state.interaction.interactionMode !== 'clip') return false;
      const frame = state.activeFrameId ? state.frames.byId[state.activeFrameId] : null;
      return frame?.latestClipTool === 'sam';
    },
    collapseWhenFalse: 'restore',
    priority: 150,
  },

  // --- 5. Initial Config ---
  initialConfig: {
    // Namespaced sub-keys for each tool (consistent with useToolConfig reads)
    [BGREMOVER_KEY]: DEFAULT_BG_REMOVAL_CONFIG,
    [UPSCALER_KEY]: DEFAULT_UPSCALE_CONFIG,
    [SEG_KEY]: DEFAULT_SEG_CONFIG,
    [ERASER_KEY]: DEFAULT_INPAINT_ERASER_CONFIG,
    // Persisted UI state
    activeTool: UPSCALER_KEY,
  },

  // --- 6. Commands ---
  commands: [...Object.values(BG_REMOVAL_COMMANDS), ...Object.values(SEG_COMMANDS), ...Object.values(UPSCALE_COMMANDS), ...Object.values(INPAINT_ERASER_COMMANDS)],

  // --- 7. Signals ---
  signals: [],

  // --- 8. Contributions ---
  contributions: [
    {
      slot: "SETTINGS_CONFIG_PANEL",
      group: "ai-tools",
      component: AIToolsSettings,
      title: "AI Tools",
      icon: <Cpu size={12} />,
      order: 310,
    },
  ],
};
