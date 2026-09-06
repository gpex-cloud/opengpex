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
import { Key } from "lucide-react";
import { AIGenerationDrawer } from "./components";
import { AIBridgeSettings } from "./panels/settings";
import { AI_BRIDGE_COMMANDS } from "./commands";
import { AIBridgeIcon } from "./icon";

import * as P from "./protocols";

export const plugin: EditorPlugin = {
  // --- 1. Identity ---
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "AI Bridge",
    version: "2.0.0",
    description:
      "Connect to AI providers (OpenAI / Gemini / Qwen / LocalAI) for image generation, editing and describing.",
    author: P.PLUGIN_AUTHOR,
    category: "drawers",
    requirements: {
      coreVersion: ">=1.0.0",
      auth: "none",
    },
  },

  // --- 2. UI Entry ---
  icon: <AIBridgeIcon />,
  slot: "SIDE_BAR",
  order: 2100,

  // --- 3. Core Implementation ---
  component: AIGenerationDrawer,

  // --- 4. Initial Config (inline, framework applies before component mount) ---
  initialConfig: {
    endpoints: P.DEFAULT_ENDPOINTS,
    activeEndpointId: "openai",
    mode: "generate",
    prompt: "",
    negativePrompt: "",
    seed: -1,
    size: "1024x1024",
    inputSource: "active-layer",
    cachedModels: {},
    generationHistory: [],
  },

  // --- 5. Commands ---
  commands: Object.values(AI_BRIDGE_COMMANDS),

  // --- 6. Contributions ---
  contributions: [
    {
      slot: "SETTINGS_CONFIG_PANEL",
      group: "ai-bridge",
      component: AIBridgeSettings,
      title: "AI Bridge Keys",
      icon: <Key size={12} />,
      order: 320,
    },
  ],
};
