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

import React, { useState, useCallback } from "react";
import { Lightbulb } from "lucide-react";
import Switch from "@opengpex/editor/widgets/Switch";
import { STORAGE_KEY_SPOTLIGHT_DISABLED, STORAGE_KEY_TIPS } from "../protocols";
import { ONBOARDING_SETTINGS_CHANGED } from "../hooks";

/**
 * Onboarding Settings Panel.
 * Contributed to the SETTINGS_CONFIG_PANEL slot.
 * Allows users to re-enable spotlights and tips after "Don't show again".
 */
export function OnboardingSettings() {
  const [spotlightEnabled, setSpotlightEnabled] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_SPOTLIGHT_DISABLED) !== "true";
    } catch {
      return true;
    }
  });

  const [tipsEnabled, setTipsEnabled] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_TIPS) !== "true";
    } catch {
      return true;
    }
  });

  const handleSpotlightToggle = useCallback((checked: boolean) => {
    setSpotlightEnabled(checked);
    try {
      localStorage.setItem(STORAGE_KEY_SPOTLIGHT_DISABLED, String(!checked));
    } catch {
      // graceful
    }
    window.dispatchEvent(new Event(ONBOARDING_SETTINGS_CHANGED));
  }, []);

  const handleTipsToggle = useCallback((checked: boolean) => {
    setTipsEnabled(checked);
    try {
      localStorage.setItem(STORAGE_KEY_TIPS, String(!checked));
    } catch {
      // graceful
    }
    window.dispatchEvent(new Event(ONBOARDING_SETTINGS_CHANGED));
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <h5 className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest flex items-center gap-1.5 pl-1">
          <Lightbulb size={11} /> Guidance & Tips
        </h5>

        {/* Spotlight toggle */}
        <div className="flex items-center justify-between rounded-xl p-3 bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-semibold text-[var(--text-main)]">
              Show Spotlight
            </span>
            <span className="text-[9px] text-[var(--text-muted)]">
              Contextual hints for new features
            </span>
          </div>
          <Switch checked={spotlightEnabled} onChange={handleSpotlightToggle} />
        </div>

        {/* Everyday Tips toggle */}
        <div className="flex items-center justify-between rounded-xl p-3 bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-semibold text-[var(--text-main)]">
              Show Everyday Tips
            </span>
            <span className="text-[9px] text-[var(--text-muted)]">
              Rotating tips about shortcuts and features
            </span>
          </div>
          <Switch checked={tipsEnabled} onChange={handleTipsToggle} />
        </div>
      </div>

      <p className="px-1 text-[8px] text-[var(--text-muted)] font-bold leading-relaxed uppercase tracking-tight italic opacity-60">
        Toggle these on to restore guidance after dismissing with &quot;Got it&quot; or &quot;Don&apos;t show again&quot;.
      </p>
    </div>
  );
}
