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

import { useState, useCallback, useMemo, useEffect } from "react";
import {
  STORAGE_KEY_TIPS,
  STORAGE_KEY_SPOTLIGHT_DISABLED,
  SPOTLIGHTS,
  EVERYDAY_TIPS,
  type SpotlightDef,
  type SpotlightTrigger,
} from "./protocols";

// ─── Storage Helpers ────────────────────────────────────────────────────────

function readSpotlightDisabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_SPOTLIGHT_DISABLED) === "true";
  } catch {
    return false;
  }
}

function writeSpotlightDisabled(disabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY_SPOTLIGHT_DISABLED, String(disabled));
  } catch {
    // graceful
  }
}

function readTipsDisabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_TIPS) === "true";
  } catch {
    return false;
  }
}

function writeTipsDisabled(disabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY_TIPS, String(disabled));
  } catch {
    // graceful
  }
}

/** Custom event name for cross-component reactivity within the same tab */
export const ONBOARDING_SETTINGS_CHANGED = "gpex:onboarding-settings-changed";

// ─── Main Hook ──────────────────────────────────────────────────────────────

export interface OnboardingState {
  /** The current active spotlight (if any) for the given trigger */
  activeSpotlight: SpotlightDef | null;
  /** Current message index within the active spotlight's messages array */
  currentMessageIndex: number;
  /** Whether the Everyday Tips banner is enabled */
  tipsEnabled: boolean;
  /** Advance to next message; if last message, dismiss the spotlight entirely */
  advanceOrDismissSpotlight: (id: string) => void;
  /** Dismiss a spotlight for this session only */
  dismissSpotlight: (id: string) => void;
  /** Dismiss spotlight forever (localStorage) */
  dismissSpotlightForever: () => void;
  /** Dismiss tips forever (localStorage) */
  dismissTipsForever: () => void;
  /** Dismiss tips for this session only */
  dismissTipsSession: () => void;
}

/**
 * useOnboarding: Central hook for onboarding state management.
 * Reads/writes localStorage for persistence. Zero cost when fully dismissed.
 *
 * @param trigger - Current trigger condition based on editor state
 */
export function useOnboarding(trigger: SpotlightTrigger): OnboardingState {
  // Session-only dismissal set (not persisted — spotlights always return on next visit)
  const [sessionDismissed, setSessionDismissed] = useState<Set<string>>(new Set);
  const [spotlightDisabledForever, setSpotlightDisabledForever] = useState<boolean>(readSpotlightDisabled);
  const [tipsDisabledForever, setTipsDisabledForever] = useState<boolean>(readTipsDisabled);
  const [tipsHiddenSession, setTipsHiddenSession] = useState(false);
  const [messageIndex, setMessageIndex] = useState(0);

  // Listen for settings changes (same-tab reactivity via custom event)
  useEffect(() => {
    const handleSettingsChange = () => {
      setSpotlightDisabledForever(readSpotlightDisabled());
      setTipsDisabledForever(readTipsDisabled());
      // Clear session dismissals when user re-enables
      if (!readSpotlightDisabled()) {
        setSessionDismissed(new Set());
      }
      if (!readTipsDisabled()) {
        setTipsHiddenSession(false);
      }
    };
    window.addEventListener(ONBOARDING_SETTINGS_CHANGED, handleSettingsChange);
    return () => window.removeEventListener(ONBOARDING_SETTINGS_CHANGED, handleSettingsChange);
  }, []);

  // Find highest-priority spotlight matching trigger and not dismissed this session
  const activeSpotlight = useMemo<SpotlightDef | null>(() => {
    if (spotlightDisabledForever) return null;
    const candidates = SPOTLIGHTS.filter((s) => {
      if (s.trigger !== "always" && s.trigger !== trigger) return false;
      if (sessionDismissed.has(s.id)) return false;
      return true;
    });
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.priority - b.priority);
    return candidates[0];
  }, [trigger, sessionDismissed, spotlightDisabledForever]);

  // Reset message index when active spotlight changes
  const prevSpotlightId = useMemo(() => activeSpotlight?.id, [activeSpotlight]);
  const [lastSpotlightId, setLastSpotlightId] = useState(prevSpotlightId);
  if (prevSpotlightId !== lastSpotlightId) {
    setLastSpotlightId(prevSpotlightId);
    setMessageIndex(0);
  }

  // Advance cycles through messages (wraps around), never auto-dismisses
  const advanceOrDismissSpotlight = useCallback((id: string) => {
    const spotlight = SPOTLIGHTS.find((s) => s.id === id);
    if (!spotlight) return;
    setMessageIndex((prev) => (prev + 1) % spotlight.messages.length);
  }, []);

  // Dismiss only for this session (no localStorage write — will show again next time)
  const dismissSpotlight = useCallback((id: string) => {
    setSessionDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setMessageIndex(0);
  }, []);

  const dismissSpotlightForever = useCallback(() => {
    setSpotlightDisabledForever(true);
    writeSpotlightDisabled(true);
  }, []);

  const dismissTipsForever = useCallback(() => {
    setTipsDisabledForever(true);
    writeTipsDisabled(true);
  }, []);

  const dismissTipsSession = useCallback(() => {
    setTipsHiddenSession(true);
  }, []);

  const tipsEnabled = !tipsDisabledForever && !tipsHiddenSession;

  return {
    activeSpotlight,
    currentMessageIndex: messageIndex,
    tipsEnabled,
    advanceOrDismissSpotlight,
    dismissSpotlight,
    dismissSpotlightForever,
    dismissTipsForever,
    dismissTipsSession,
  };
}

// ─── Tips Rotation Hook ─────────────────────────────────────────────────────

/**
 * useTipRotation: Provides auto-rotating tips with idle/interaction awareness.
 */
export function useTipRotation(interval: number) {
  const [currentIndex, setCurrentIndex] = useState(
    () => Math.floor(Math.random() * EVERYDAY_TIPS.length),
  );

  const currentTip = EVERYDAY_TIPS[currentIndex];

  const advance = useCallback(() => {
    setCurrentIndex((prev) => (prev + 1) % EVERYDAY_TIPS.length);
  }, []);

  const goBack = useCallback(() => {
    setCurrentIndex((prev) => (prev - 1 + EVERYDAY_TIPS.length) % EVERYDAY_TIPS.length);
  }, []);

  return { currentTip, currentIndex, total: EVERYDAY_TIPS.length, advance, goBack, interval };
}
