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

"use client";

import { EditorPlugin } from "@opengpex/editor/core/types";
import { AnimationComponent } from "./components";
import { ANIMATION_COMMANDS } from "./commands";

import { Clapperboard } from "lucide-react";

import * as P from "./protocols";

/**
 * Animation Plugin: Playback and export for animated sequences (GIF, APNG, etc.)
 *
 * This plugin is conditionally visible — only appears when the active frame
 * contains animation sequence layers (detected via gifSequenceId metadata).
 */
export const plugin: EditorPlugin = {
   // --- 1. Identity ---
   manifest: {
      id: P.PLUGIN_ID,
      displayName: "Animation",
      version: "1.0.0",
      description: "Playback controls and export for animated image sequences (GIF, APNG).",
      category: "drawers",
      author: P.PLUGIN_AUTHOR,
      requirements: {
         coreVersion: ">=1.0.0",
         auth: "none",
      },
   },

   // --- 2. UI Entry ---
   icon: <Clapperboard size={20} />,
   slot: "SIDE_BAR",
   side: "right",
   order: 3300, // Just after ImageInfoDrawer (1200)
   show: "frame-required",

   // --- 3. Core Implementation ---
   component: AnimationComponent,
   initialConfig: {
      format: "gif",
      loop: false, // Default: play once, no loop
      frameRateOverride: 0, // 0 = Auto: use per-frame gifFrameDelay from metadata (preserves original timing)
   },

   // --- 4. Auto-Reveal ---
   autoReveal: {
      // Expand when an animation sequence is detected
      when: (state) => {
         if (!state.activeFrameId) return false;
         const frame = state.frames?.byId?.[state.activeFrameId];
         if (!frame) return false;
         return frame.layers.order.some((id: string) => {
            const layer = frame.layers.byId[id];
            return layer?.metadata?.gifSequenceId != null;
         });
      },
      priority: 110,
   },

   // --- 5. Capabilities ---
   commands: Object.values(ANIMATION_COMMANDS),
};

export default plugin;
