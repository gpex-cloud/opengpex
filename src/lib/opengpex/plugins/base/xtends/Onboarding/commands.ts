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

import type { EditorCommand } from "@opengpex/editor/core/types";
import {
  CMD_DISMISS_SPOTLIGHT,
  CMD_DISMISS_TIPS,
  CMD_RESET_ONBOARDING,
  STORAGE_KEY_TIPS,
} from "./protocols";

/**
 * cmd.dismiss_spotlight: Programmatically dismiss a spotlight hint for this session.
 * Note: Spotlights are session-only and always return on the next visit.
 * Payload: { spotlightId: string }
 */
const dismissSpotlightCmd: EditorCommand = {
  id: CMD_DISMISS_SPOTLIGHT,
  name: "Dismiss Onboarding Spotlight",
  execute: (_ctx, _payload?: { spotlightId: string }) => {
    // Session-only dismiss — no localStorage write.
    // The actual dismissal is handled by React state in useOnboarding hook.
    // This command exists for programmatic API consistency.
  },
};

/**
 * cmd.dismiss_tips: Programmatically disable Everyday Tips forever.
 */
const dismissTipsCmd: EditorCommand = {
  id: CMD_DISMISS_TIPS,
  name: "Dismiss Everyday Tips",
  execute: () => {
    try {
      localStorage.setItem(STORAGE_KEY_TIPS, "true");
    } catch {
      // graceful
    }
  },
};

/**
 * cmd.reset_onboarding: Reset all onboarding state (re-enable tips).
 * Spotlights are session-only and always return on reload.
 * Useful for testing or when a user wants to see the guidance again.
 * Can be invoked from browser console: `gpex.exec('cmd.reset_onboarding')`
 */
const resetOnboardingCmd: EditorCommand = {
  id: CMD_RESET_ONBOARDING,
  name: "Reset Onboarding",
  execute: () => {
    try {
      localStorage.removeItem(STORAGE_KEY_TIPS);
    } catch {
      // graceful
    }
  },
};

export const ONBOARDING_COMMANDS = {
  dismissSpotlight: dismissSpotlightCmd,
  dismissTips: dismissTipsCmd,
  resetOnboarding: resetOnboardingCmd,
};
