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
  const aiPrompt = String(extra.ai_prompt || "");
  const aiNegativePrompt = extra.ai_negative_prompt
    ? String(extra.ai_negative_prompt)
    : null;
  const aiSeed =
    extra.ai_seed !== undefined ? String(extra.ai_seed) : null;

  const detailedItems = [
    { label: "Prompt", value: aiPrompt },
    { label: "Negative Prompt", value: aiNegativePrompt },
    { label: "Seed", value: aiSeed },
  ].filter((item) => !!item.value);

  return (
    <div>
      <div className="flex flex-col bg-indigo-500/5 rounded-xl border border-indigo-500/20 overflow-hidden transition-all duration-300 mt-2">
        {/* Summary Header */}
        <button
          onClick={() => setIsAiInfoExpanded(!isAiInfoExpanded)}
          className="w-full flex items-center justify-between p-2 hover:bg-indigo-500/10 transition-colors text-left select-none"
        >
          <div className="flex flex-col pr-2 overflow-hidden">
            <span className="text-[8px] font-black text-indigo-400 uppercase tracking-tight mb-1">
              AI Generation Data
            </span>
            <span className="text-[10px] font-black text-indigo-400 truncate">
              {aiProvider}
            </span>
          </div>
          <ChevronDown
            size={14}
            className={`text-indigo-400 shrink-0 transition-transform duration-300 ${isAiInfoExpanded ? "rotate-180" : ""}`}
          />
        </button>

        {/* Expanded Details */}
        {isAiInfoExpanded && (
          <div className="flex flex-col gap-1.5 p-2 pt-0 border-t border-indigo-500/20 mt-1 pt-2 animate-in fade-in slide-in-from-top-1 duration-200">
            {detailedItems.map((item, i) => (
              <div
                key={i}
                className="flex flex-col gap-1 mb-1 group relative"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[8px] font-bold text-indigo-400 uppercase tracking-wider">
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
                        className="text-indigo-400 hover transition-colors"
                      />
                    )}
                  </button>
                </div>
                <span className="text-[9px] font-semibold text-[var(--text-main)] break-words">
                  {String(item.value)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
