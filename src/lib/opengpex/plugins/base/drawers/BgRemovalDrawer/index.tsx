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
import { BgRemovalDrawerContent } from "./components";
import { BgRemovalModelSettings } from "./panels/settings";
import { BG_REMOVAL_COMMANDS } from "./commands";
import { BgRemovalIcon } from "./icon";

import * as P from "./protocols";

/**
 * BgRemovalDrawer Plugin — AI Background Removal
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
    displayName: "AI Background Removal",
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
  icon: <BgRemovalIcon />,
  slot: "SIDE_BAR",
  show: 'frame-required',

  order: 2200, // Between Adjustment (80) and AIBridge (90)

  // --- 3. Core Implementation ---
  component: BgRemovalDrawerContent,

  // --- 4. Initial Config ---
  initialConfig: P.DEFAULT_BG_REMOVAL_CONFIG,

  // --- 5. Commands ---
  commands: Object.values(BG_REMOVAL_COMMANDS),

  // --- 6. Signals ---
  signals: [
    {
      id: P.SIGNAL_STATUS,
      name: "BG Removal Status",
      defaultValue: P.INITIAL_STATUS,
      scope: "public",
    },
  ],

  // --- 7. Contributions ---
  contributions: [
    {
      slot: "SETTINGS_CONFIG_PANEL",
      group: "BG Remover",
      component: BgRemovalModelSettings,
      title: "BG Removal Models",
      icon: <Cpu size={12} />,
      order: 310,
    },
  ],
};
