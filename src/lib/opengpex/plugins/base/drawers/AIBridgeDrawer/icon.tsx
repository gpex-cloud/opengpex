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

import { useEditorState } from "@opengpex/editor/core/context";
import { SIGNAL_IS_GENERATING } from "./protocols";

/**
 * AIBridgeIcon: Responsive sidebar icon
 * Displays "AI" text normally, shows colored marquee animation cycle when generating.
 */
export function AIBridgeIcon() {
  const { state } = useEditorState();
  const isGenerating = Boolean(state.getStateSignal(SIGNAL_IS_GENERATING));

  if (isGenerating) {
    return (
      <>
        <style>{`
          @keyframes ai-rainbow {
            0% { background-position: 0% 50%; }
            100% { background-position: 200% 50%; }
          }
        `}</style>
        <span
          className="font-black text-[14px] uppercase leading-none px-[2px]"
          style={{
            backgroundImage:
              "linear-gradient(90deg, #6366f1, #ec4899, #f59e0b, #10b981, #3b82f6, #8b5cf6, #6366f1)",
            backgroundSize: "200% 100%",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
            animation: "ai-rainbow 2s linear infinite",
          }}
        >
          AI
        </span>
      </>
    );
  }

  return (
    <span className="font-black text-[14px] uppercase leading-none px-[2px]">
      AI
    </span>
  );
}
