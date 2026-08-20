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
 * Each tool's settings are rendered via its own self-contained SettingsSection
 * component, keeping this file as a thin orchestration layer.
 */

import { useMemo, useState } from "react";
import type { ComponentType } from "react";
import { Cpu, Shapes, ArrowUpRight, Eraser, Info, Loader2 } from "lucide-react";
import { usePluginSelfConfig } from "@opengpex/editor/core/context";
import { useDownloadTask } from "./_shared";

// ─── Tool Identity (from each tool's protocols) ──────────────────────────────
import { MODEL_TYPE_KEY as UPSCALER_KEY, MODEL_TYPE_NAME as UPSCALER_NAME, BUILTIN_UPSCALE_MODELS } from "./upscaler/protocols";
import { MODEL_TYPE_KEY as BGREMOVER_KEY, MODEL_TYPE_NAME as BGREMOVER_NAME, BUILTIN_MODELS } from "./bgremover/protocols";
import { MODEL_TYPE_KEY as SEG_KEY, MODEL_TYPE_NAME as SEG_NAME, BUILTIN_SEG_MODELS } from "./segmentation/protocols";
import { MODEL_TYPE_KEY as ERASER_KEY, MODEL_TYPE_NAME as ERASER_NAME, BUILTIN_ERASER_MODELS } from "./inpaint/eraser/protocols";

// ─── Self-contained Settings Sections ────────────────────────────────────────
import { UpscalerSettingsSection } from "./upscaler/components/settings";
import { BgRemoverSettingsSection } from "./bgremover/components/settings";
import { SegSettingsSection } from "./segmentation/components/settings";
import { InpaintEraserSettingsSection } from "./inpaint/eraser/components/settings";

import type { ModelCatalog } from "./_shared/types";

// ─── Tab Definitions ─────────────────────────────────────────────────────────

interface ToolTab {
  key: string;
  label: string;
  icon: typeof Cpu;
  Section: ComponentType;
}

const TABS: ToolTab[] = [
  { key: UPSCALER_KEY, label: UPSCALER_NAME, icon: ArrowUpRight, Section: UpscalerSettingsSection },
  { key: BGREMOVER_KEY, label: BGREMOVER_NAME, icon: Cpu, Section: BgRemoverSettingsSection },
  { key: SEG_KEY, label: SEG_NAME, icon: Shapes, Section: SegSettingsSection },
  { key: ERASER_KEY, label: ERASER_NAME, icon: Eraser, Section: InpaintEraserSettingsSection },
];

// ─── Builtin model lookup (for download/custom-model badge detection) ────────

const BUILTINS_BY_KEY: Record<string, { modelId: string; builtin?: boolean }[]> = {
  [UPSCALER_KEY]: BUILTIN_UPSCALE_MODELS,
  [BGREMOVER_KEY]: BUILTIN_MODELS,
  [SEG_KEY]: BUILTIN_SEG_MODELS,
  [ERASER_KEY]: BUILTIN_ERASER_MODELS,
};

/**
 * Map the drawer's activeTool (UI navigation value persisted in config) to
 * a settings tab key (MODEL_TYPE_KEY).
 *
 * Note: components.tsx uses UI-friendly names ('bg-removal', 'segmentation',
 * 'inpaint-eraser') while tab keys are MODEL_TYPE_KEY values ('bgremover',
 * 'seg', 'inpaintEraser').
 */
const ACTIVE_TOOL_TO_TAB: Record<string, string> = {
  'upscaler': UPSCALER_KEY,
  'bg-removal': BGREMOVER_KEY,
  'segmentation': SEG_KEY,
  'inpaint-eraser': ERASER_KEY,
};

function toolToTabKey(activeTool: string | undefined): string {
  if (!activeTool) return TABS[0].key;
  const mapped = ACTIVE_TOOL_TO_TAB[activeTool];
  if (mapped) return mapped;
  // Fallback: direct key match (in case activeTool already is a MODEL_TYPE_KEY)
  const found = TABS.find(t => t.key === activeTool);
  return found ? found.key : TABS[0].key;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function AIToolsSettings() {
  const [config] = usePluginSelfConfig<Record<string, unknown>>();
  const [activeTab, setActiveTab] = useState<string>(() => toolToTabKey(config?.activeTool as string | undefined));
  const { task, isDownloading } = useDownloadTask();

  // Determine which tab the current download belongs to
  const downloadingTab = useMemo<string | null>(() => {
    if (!isDownloading || !task) return null;
    const downloadModelId = task.modelId;
    for (const tab of TABS) {
      const models = (config?.[tab.key] as ModelCatalog | undefined)?.models ?? BUILTINS_BY_KEY[tab.key] ?? [];
      if (models.some(m => m.modelId === downloadModelId)) return tab.key;
    }
    return null;
  }, [isDownloading, task, config]);

  // Detect which tabs have custom (non-builtin) models
  const customModelTabs = useMemo<Set<string>>(() => {
    const tabs = new Set<string>();
    for (const tab of TABS) {
      const models = (config?.[tab.key] as ModelCatalog | undefined)?.models ?? BUILTINS_BY_KEY[tab.key] ?? [];
      if (models.some(m => !m.builtin)) tabs.add(tab.key);
    }
    return tabs;
  }, [config]);

  const ActiveSection = TABS.find(t => t.key === activeTab)?.Section ?? TABS[0].Section;

  return (
    <div className="flex flex-col gap-4">
      {/* ─── Segment Control (Pill Toggle) ────────────────────── */}
      <div className="flex gap-0.5 p-0.5 rounded-lg bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          const hasCustom = customModelTabs.has(tab.key);
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-1 relative flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all duration-150 ${
                isActive
                  ? "bg-[var(--bg-panel)] text-[var(--text-main)] shadow-sm"
                  : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
            >
              <Icon size={10} />
              {tab.label}
              {downloadingTab === tab.key && (
                <Loader2 size={9} className="animate-spin text-[var(--text-secondary)]" />
              )}
              {hasCustom && (
                <span
                  className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-amber-400"
                  title="Has custom models"
                />
              )}
            </button>
          );
        })}
      </div>

      {/* ─── Tab Content (delegated to each tool's SettingsSection) ─── */}
      <ActiveSection />

      {/* ─── Info Callout ─────────────────────────────────────── */}
      <div className="flex gap-2 items-start px-2.5 py-2 rounded-lg bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
        <Info size={11} className="text-[var(--text-muted)] shrink-0 mt-0.5" />
        <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
          Models are downloaded from internet and cached locally in your
          browser. Built-in model configs cannot be modified or removed. Custom
          models should provide a valid HuggingFace repository ID with ONNX format.
        </p>
      </div>
    </div>
  );
}
