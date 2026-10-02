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

import React from "react";
import { useEditorState } from "@opengpex/editor/core/context";
import { useOnboarding } from "./hooks";
import { SpotlightBubble } from "./panels/SpotlightBubble";
import { EverydayTips } from "./panels/EverydayTips";
import { WelcomeModal } from "./panels/WelcomeModal";

/**
 * OnboardingComponent: ROOT_OVERLAY plugin component.
 * Renders SpotlightBubble, EverydayTips, and WelcomeModal directly in Window space.
 * Full-screen pointer-events-none container; individual elements opt-in to interaction.
 */
export function OnboardingComponent() {
  const { state } = useEditorState();
  const hasFrames = state.frames.order.length > 0;
  const trigger = hasFrames ? "has-frame" : "no-frame";

  const onboarding = useOnboarding(trigger);

  return (
    <div
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 5500 }}
    >
      {/* WelcomeModal: shown once per browser on first v2 visit */}
      {onboarding.showWelcomeModal && (
        <WelcomeModal onDismiss={onboarding.dismissWelcomeModal} />
      )}

      {/* SpotlightBubble: show only when we have an active spotlight */}
      {!onboarding.showWelcomeModal && onboarding.activeSpotlight && (
        <SpotlightBubble
          spotlight={onboarding.activeSpotlight}
          messageIndex={onboarding.currentMessageIndex}
          onAdvance={onboarding.advanceOrDismissSpotlight}
          onDismiss={onboarding.dismissSpotlight}
          onDismissForever={onboarding.dismissSpotlightForever}
        />
      )}

      {/* EverydayTips: only when frames are loaded and tips enabled */}
      {!onboarding.showWelcomeModal && hasFrames && onboarding.tipsEnabled && (
        <EverydayTips
          onDismissForever={onboarding.dismissTipsForever}
          onDismissSession={onboarding.dismissTipsSession}
        />
      )}
    </div>
  );
}
