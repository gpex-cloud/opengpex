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
import { BgRemoverDrawerContent } from "./components";
import { AIToolsSettings } from "./settings";
import { BG_REMOVAL_COMMANDS } from "./bgremover/commands";
import { SEG_COMMANDS } from "./segmentation/commands";
import { UPSCALE_COMMANDS } from "./upscaler/commands";
import { AIToolsIcon } from "./icon";

import * as P from "./protocols";

/**
 * BgRemoverDrawer Plugin — AI Background Removal
 *
 * Provides one-click AI-powered background removal via in-browser inference.
 * Supports multiple models: RMBG 1.4, BiRefNet General, InSPyReNet Ultra,
 * plus user-added custom models from HuggingFace.
 *
 * Runs entirely client-side (WebGPU → WASM fallback).
 *
 * Architecture (per 202606026_ai_bg_removal_spec):
 *   - Drawer plugin in SIDE_BAR slot (order 85 — between AdjustmentDrawer and AIBridge)
 *   - Worker-based inference pipeline (persistent singleton, Mode B)
 *   - Result written as LocalPolygon to clipBoxes['wand']
 *   - Marching-ants preview via existing ClipOverlay infrastructure
 *   - Apply: user applies mask via ClipOptions "Apply Mask" button (adv.layer.clip.toMask)
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

  order: 2200, // Between Adjustment (80) and AIBridge (90)

  // --- 3. Core Implementation ---
  component: BgRemoverDrawerContent,

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
    collapseWhenFalse: false,
    priority: 150,
  },

  // --- 5. Initial Config ---
  initialConfig: P.DEFAULT_BG_REMOVAL_CONFIG,

  // --- 5. Commands ---
  commands: [...Object.values(BG_REMOVAL_COMMANDS), ...Object.values(SEG_COMMANDS), ...Object.values(UPSCALE_COMMANDS)],

  // --- 6. Signals ---
  signals: [
    {
      id: P.SIGNAL_STATUS,
      name: "BG Remover Status",
      defaultValue: P.INITIAL_STATUS,
      scope: "public",
    },
    {
      id: P.SIGNAL_SEG_STATUS,
      name: "Segmentation Status",
      defaultValue: P.INITIAL_SEG_STATUS,
      scope: "public",
    },
    {
      id: P.SIGNAL_UPSCALE_STATUS,
      name: "Upscaler Status",
      defaultValue: P.INITIAL_UPSCALE_STATUS,
      scope: "public",
    },
  ],

  // --- 7. Contributions ---
  contributions: [
    {
      slot: "SETTINGS_CONFIG_PANEL",
      group: "AI Tools",
      component: AIToolsSettings,
      title: "AI Tools Models",
      icon: <Cpu size={12} />,
      order: 310,
    },
  ],
};
