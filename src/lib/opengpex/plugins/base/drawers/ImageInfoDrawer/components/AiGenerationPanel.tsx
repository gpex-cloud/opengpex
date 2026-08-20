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
import { ChevronDown } from "lucide-react";
import FancyTextArea from "@opengpex/editor/widgets/FancyTextArea";

interface AiGenerationPanelProps {
  extra?: Record<string, unknown>;
}

export function AiGenerationPanel({ extra }: AiGenerationPanelProps) {
  const [isAiInfoExpanded, setIsAiInfoExpanded] = React.useState(false);

  if (!extra?.ai_generation) return null;

  const aiProvider = String(extra.ai_provider || "Unknown Provider");
  const aiModel = extra.ai_model ? String(extra.ai_model) : null;
  const aiModeRaw = extra.ai_mode ? String(extra.ai_mode) : null;
  const aiMode = aiModeRaw === "generate" ? "Generate"
    : aiModeRaw === "edit" ? "Edit"
    : aiModeRaw === "variations" ? "Vary"
    : aiModeRaw;
  const aiSize = extra.ai_size ? String(extra.ai_size) : null;
  const aiSeed = extra.ai_seed !== undefined ? String(extra.ai_seed) : null;
  const aiDurationMs = extra.ai_duration_ms !== undefined ? String(extra.ai_duration_ms) : null;
  const aiPrompt = String(extra.ai_positive_prompt || "");
  const aiNegativePrompt = extra.ai_negative_prompt
    ? String(extra.ai_negative_prompt)
    : null;

  const metaItems = [
    { label: "Provider", value: aiProvider },
    { label: "Model", value: aiModel },
    { label: "Mode", value: aiMode },
    { label: "Size", value: aiSize },
    { label: "Seed", value: aiSeed },
    { label: "Duration", value: aiDurationMs ? `${aiDurationMs}ms` : null },
  ].filter((item) => !!item.value);

  const textItems = [
    { label: "Prompt", value: aiPrompt },
    { label: "Negative Prompt", value: aiNegativePrompt },
  ].filter((item) => !!item.value);

  return (
    <div>
      <div className="flex flex-col bg-[var(--bg-stage)] rounded-xl border border-[var(--border-subtle)] overflow-hidden transition-all duration-300">
        {/* Summary Header */}
        <button
          onClick={() => setIsAiInfoExpanded(!isAiInfoExpanded)}
          className="w-full flex items-center justify-between p-2 hover:bg-[var(--bg-stage)] transition-colors text-left select-none"
        >
          <div className="flex flex-col pr-2 overflow-hidden">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight">
                AI-Gen Metadata
              </span>
              {aiModeRaw && (
                <span className="text-[8px] font-bold text-[var(--text-muted)] bg-[var(--bg-stage)] px-1.5 py-0.5 rounded shadow-sm border border-[var(--border-subtle)] uppercase shrink-0">
                  {aiModeRaw}
                </span>
              )}
            </div>
            <span className="text-[10px] font-black text-[var(--text-main)] truncate">
              <span className="text-[var(--text-muted)] font-bold">from </span>{aiProvider}
            </span>
          </div>
          <ChevronDown
            size={14}
            className={`text-[var(--text-muted)] shrink-0 transition-transform duration-300 ${isAiInfoExpanded ? "rotate-180" : ""}`}
          />
        </button>

        {/* Expanded Details */}
        {isAiInfoExpanded && (
          <div className="flex flex-col gap-1.5 p-2 pt-0 border-t border-[var(--border-subtle)] dark:border-white/10 mt-1 pt-2 animate-in fade-in slide-in-from-top-1 duration-200">
            {/* Short Metadata Rows */}
            {metaItems.map((item, i) => (
              <div
                key={i}
                className="flex justify-between items-baseline gap-2"
              >
                <span className="text-[8px] font-bold text-[var(--text-muted)] uppercase tracking-wider shrink-0">
                  {item.label}
                </span>
                <span className="text-[9px] font-semibold text-[var(--text-main)] text-right break-words">
                  {String(item.value)}
                </span>
              </div>
            ))}

            {/* Long Text Metadata (Prompts) — readonly with copy button */}
            {textItems.map((item, i) => (
              <FancyTextArea
                key={`text-${i}`}
                value={String(item.value)}
                readonly
                label={item.label}
                // labelClassName={item.label === "Negative Prompt" ? "!text-rose-500/80" : "!text-emerald-500/80"}
                actions={{ copy: true }}
                height="h-[80px]"
                slim
                className="border-0 rounded-none bg-transparent"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
