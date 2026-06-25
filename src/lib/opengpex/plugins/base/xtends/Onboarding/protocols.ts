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

// ─── Plugin Identity ────────────────────────────────────────────────────────
export const PLUGIN_ID = "xtends.onboarding";
export const PLUGIN_AUTHOR = "opengpex";

// ─── Command IDs ────────────────────────────────────────────────────────────
export const CMD_DISMISS_SPOTLIGHT = "cmd.dismiss_spotlight";
export const CMD_DISMISS_TIPS = "cmd.dismiss_tips";
export const CMD_RESET_ONBOARDING = "cmd.reset_onboarding";

// ─── LocalStorage Keys ──────────────────────────────────────────────────────
export const STORAGE_KEY_SPOTLIGHTS = "gpex_onboarding_dismissed_spotlights";
export const STORAGE_KEY_SPOTLIGHT_DISABLED = "gpex_onboarding_spotlight_disabled";
export const STORAGE_KEY_TIPS = "gpex_onboarding_tips_disabled";

// ─── Spotlight Definitions ──────────────────────────────────────────────────

export type SpotlightTrigger = "no-frame" | "has-frame" | "always";

/** Which side of the target the bubble appears */
export type SpotlightPosition = "left" | "right" | "top" | "bottom";

export interface SpotlightDef {
  /** Unique identifier for persistence (one per target location) */
  id: string;
  /** CSS selector to find the target DOM element (e.g. `[data-drawer-bar="right"]`) */
  target: string;
  /** Optional child selector within target to pinpoint the exact element (e.g. `.cursor-pointer`) */
  targetChild?: string;
  /** Which side of the target to position the bubble */
  position: SpotlightPosition;
  /** When this spotlight should appear */
  trigger: SpotlightTrigger;
  /** Multiple messages to show (cycled on dismiss, spotlight fully dismissed when all seen) */
  messages: string[];
  /** Priority: lower number = higher priority */
  priority: number;
}

/** All defined spotlight hints */
export const SPOTLIGHTS: SpotlightDef[] = [
  {
    id: "ai-bridge-intro",
    target: '[data-drawer-bar="right"]',
    targetChild: ".cursor-pointer",
    position: "left",
    trigger: "no-frame",
    messages: [
      "Generate images using your own AI service — just add an API key to get started. Results are imported automatically, ready to edit.",
    ],
    priority: 10,
  },
  // Example: future spotlight for left toolbar
  // {
  //   id: "tool-menu-intro",
  //   target: '[data-tool-menu]',
  //   targetChild: 'button:first-child',
  //   position: "right",
  //   trigger: "has-frame",
  //   messages: ["🖌️ Select tools here to draw, erase, clip and more!"],
  //   priority: 20,
  // },
];

// ─── Everyday Tips ──────────────────────────────────────────────────────────

export interface TipDef {
  id: string;
  text: string;
}

export const EVERYDAY_TIPS: TipDef[] = [
  { id: "tip-ai", text: "Use AI Bridge (top-right ✨) to generate images with text prompts" },
  { id: "tip-undo", text: "Press Ctrl+Z / ⌘Z to undo, Ctrl+Shift+Z / ⌘⇧Z to redo" },
  { id: "tip-layers", text: "Open the Layers panel on the left to manage layer order and visibility" },
  { id: "tip-clip-space", text: "Press Space to enter Clip mode and crop your image quickly" },
  { id: "tip-fit", text: "Press Ctrl+1 / ⌘1 to fit the image to your viewport" },
  { id: "tip-drag-sidebar", text: "Drag sidebar icons to reorder them, or move them between sides" },
];

// ─── Plugin Config ──────────────────────────────────────────────────────────

export interface OnboardingConfig {
  [key: string]: unknown;
  /** Delay in ms before showing spotlight after mount */
  spotlightDelay: number;
  /** Duration in ms between tip rotations */
  tipRotationInterval: number;
}

export const DEFAULT_CONFIG: OnboardingConfig = {
  spotlightDelay: 600,
  tipRotationInterval: 6000,
};
