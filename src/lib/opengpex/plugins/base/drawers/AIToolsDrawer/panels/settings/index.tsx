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

/**
 * AIToolsSettings — Unified settings panel for all AI tools.
 *
 * Uses a pill-style segment control to switch between tool categories.
 * Each tool contributes its own settings section as a tab panel.
 */

import { useMemo, useState } from "react";
import { Cpu, Shapes, Info, Loader2 } from "lucide-react";
import { usePluginSelfConfig } from "@opengpex/editor/core/context";
import { useDownloadTask } from "../../services";
import type { BgRemoverConfig, SegConfig } from "../../protocols";
import { BUILTIN_MODELS, BUILTIN_SEG_MODELS, DEFAULT_SEG_CONFIG } from "../../protocols";
import { BgRemoverModelSettings } from "./bgremover";
import { SegmentationModelSettings } from "./segmentation";

type SettingsTab = "bg-removal" | "segmentation";

const TABS: { value: SettingsTab; label: string; icon: typeof Cpu }[] = [
  { value: "bg-removal", label: "BG Removal", icon: Cpu },
  { value: "segmentation", label: "Segmentation", icon: Shapes },
];

export function AIToolsSettings() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("bg-removal");
  const { task, isDownloading } = useDownloadTask();
  const [config] = usePluginSelfConfig<BgRemoverConfig & { seg?: SegConfig }>();

  // Determine which tab the current download belongs to
  const downloadingTab = useMemo<SettingsTab | null>(() => {
    if (!isDownloading || !task) return null;
    const downloadModelId = task.modelId;
    // Check if it's a BG removal model
    const bgModelIds = new Set((config.models ?? BUILTIN_MODELS).map(m => m.modelId));
    if (bgModelIds.has(downloadModelId)) return "bg-removal";
    // Check if it's a segmentation model
    const segModels = (config.seg ?? DEFAULT_SEG_CONFIG).models ?? BUILTIN_SEG_MODELS;
    const segModelIds = new Set(segModels.map(m => m.modelId));
    if (segModelIds.has(downloadModelId)) return "segmentation";
    return null;
  }, [isDownloading, task, config]);

  return (
    <div className="flex flex-col gap-4">
      {/* ─── Segment Control (Pill Toggle) ────────────────────── */}
      <div className="flex gap-0.5 p-0.5 rounded-lg bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.value;
          return (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all duration-150 ${
                isActive
                  ? "bg-[var(--bg-panel)] text-[var(--text-main)] shadow-sm"
                  : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
            >
              <Icon size={10} />
              {tab.label}
              {downloadingTab === tab.value && (
                <Loader2 size={9} className="animate-spin text-[var(--text-secondary)]" />
              )}
            </button>
          );
        })}
      </div>

      {/* ─── Tab Content ──────────────────────────────────────── */}
      {activeTab === "bg-removal" && <BgRemoverModelSettings />}
      {activeTab === "segmentation" && <SegmentationModelSettings />}

      {/* ─── Info Callout ─────────────────────────────────────── */}
      <div className="flex gap-2 items-start px-2.5 py-2 rounded-lg bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
        <Info size={11} className="text-[var(--text-muted)] shrink-0 mt-0.5" />
        <p className="text-[9px] text-[var(--text-muted)] leading-relaxed">
          Models are downloaded from HuggingFace and cached locally in your
          browser. Built-in models (🔒) cannot be modified or removed. Custom
          models must provide a valid HuggingFace repository ID with ONNX format.
        </p>
      </div>
    </div>
  );
}
