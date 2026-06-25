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
import { OnboardingComponent } from "./components";
import { OnboardingSettings } from "./panels/settings";
import { ONBOARDING_COMMANDS } from "./commands";
import { Lightbulb } from "lucide-react";
import * as P from "./protocols";

/**
 * Onboarding Plugin: Contextual guidance system for new users.
 *
 * Provides:
 * - SpotlightBubble: Animated bubble pointing at the AI Bridge drawer icon
 *   when no frames are open, guiding new users to their first action.
 *   Always visible (no auto-fade), only dismissed via close button (session-only,
 *   returns on next visit).
 * - EverydayTips: Rotating tip banner at the bottom of the viewport when
 *   frames are loaded, teaching users keyboard shortcuts and features.
 *
 * Spotlight dismissal is session-only — spotlights always return on next visit.
 * Tips can be dismissed per-session or permanently (localStorage).
 *
 * Slot: ROOT_OVERLAY (Window space, z-index above all panels)
 * Show: always-show (active regardless of frame state)
 */
export const plugin: EditorPlugin = {
  manifest: {
    id: P.PLUGIN_ID,
    displayName: "Onboarding Guide",
    version: "1.0.0",
    description:
      "Contextual guidance system with spotlight bubbles and everyday tips for new users.",
    category: "xtends",
    author: P.PLUGIN_AUTHOR,
  },
  slot: "ROOT_OVERLAY",
  show: "always-show",
  order: 900,
  component: OnboardingComponent,
  commands: Object.values(ONBOARDING_COMMANDS),
  initialConfig: P.DEFAULT_CONFIG,
  contributions: [
    {
      slot: "SETTINGS_CONFIG_PANEL",
      group: "Onboarding",
      component: OnboardingSettings,
      title: "Guidance",
      icon: <Lightbulb size={12} />,
      order: 300,
    },
  ],
};

export default plugin;
