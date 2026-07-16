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
import { ChevronDown, Check, Copy } from "lucide-react";

interface AiGenerationPanelProps {
  extra?: Record<string, unknown>;
}

export function AiGenerationPanel({ extra }: AiGenerationPanelProps) {
  const [isAiInfoExpanded, setIsAiInfoExpanded] = React.useState(false);
  const [copiedField, setCopiedField] = React.useState<string | null>(null);

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

  // Summary line: model + mode
  const summaryLine = [aiModel, aiMode].filter(Boolean).join(" • ");

  return (
    <div>
      <div className="flex flex-col bg-[var(--bg-stage)] rounded-xl border border-[var(--border-subtle)] overflow-hidden transition-all duration-300">
        {/* Summary Header */}
        <button
          onClick={() => setIsAiInfoExpanded(!isAiInfoExpanded)}
          className="w-full flex items-center justify-between p-2 hover:bg-[var(--bg-stage)] transition-colors text-left select-none"
        >
          <div className="flex flex-col pr-2 overflow-hidden">
            <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight mb-1">
              AI Generation Data
            </span>
            <span className="text-[10px] font-black text-[var(--text-main)] truncate">
              {summaryLine || aiProvider}
            </span>
            <span className="text-[8px] font-bold text-[var(--text-muted)] truncate mt-0.5">
              {aiProvider}
            </span>
          </div>
          <ChevronDown
            size={14}
            className={`text-[var(--text-muted)] shrink-0 transition-transform duration-300 ${isAiInfoExpanded ? "rotate-180" : ""}`}
          />
        </button>

        {/* Expanded Details */}
        {isAiInfoExpanded && (
          <div className="flex flex-col gap-1.5 p-2 pt-0 border-t border-[var(--border-subtle)] mt-1 pt-2 animate-in fade-in slide-in-from-top-1 duration-200">
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

            {/* Long Text Metadata (Prompts) */}
            {textItems.map((item, i) => (
              <div
                key={`text-${i}`}
                className="flex flex-col gap-1 mt-1.5 pt-1.5 border-t border-[var(--border-subtle)]"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[8px] font-bold text-[var(--text-muted)] uppercase tracking-wider">
                    {item.label}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard
                        .writeText(String(item.value))
                        .then(() => {
                          setCopiedField(item.label);
                          setTimeout(() => setCopiedField(null), 2000);
                        });
                    }}
                    className="p-0.5 rounded transition-opacity focus:outline-none focus:ring-0"
                    title="Copy to clipboard"
                  >
                    {copiedField === item.label ? (
                      <Check size={10} className="text-emerald-500" />
                    ) : (
                      <Copy
                        size={10}
                        className="text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors"
                      />
                    )}
                  </button>
                </div>
                <p className="text-[9px] font-semibold text-[var(--text-main)] leading-relaxed break-words whitespace-pre-wrap max-h-[80px] overflow-y-auto">
                  {String(item.value)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
