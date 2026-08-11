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
 * Each tool's settings are rendered inline via the declarative <ModelSettings> component.
 */

import { useMemo, useState } from "react";
import { Cpu, Shapes, ArrowUpRight, Eraser, Info, Loader2 } from "lucide-react";
import { usePluginSelfConfig } from "@opengpex/editor/core/context";
import { useDownloadTask } from "./_shared";
import { ModelSettings } from "./_shared/ui/settings/ModelSettings";
import type { SegConfig } from "./segmentation/protocols";
import type { UpscaleConfig } from "./upscaler/protocols";
import type { InpaintEraserConfig } from "./inpaint/eraser/protocols";
import type { ModelEntry, ModelCatalog } from "./_shared/types";
import type { SegModelEntry } from "./segmentation/protocols";
import type { UpscaleModelEntry } from "./upscaler/protocols";
import type { InpaintEraserModelEntry } from "./inpaint/eraser/protocols";
import { BUILTIN_MODELS, DEFAULT_BG_REMOVAL_CONFIG } from "./bgremover/protocols";
import { BUILTIN_SEG_MODELS, DEFAULT_SEG_CONFIG, DEFAULT_SEG_ENCODER_FILE, DEFAULT_SEG_DECODER_FILE, getSegModelFiles } from "./segmentation/protocols";
import { BUILTIN_UPSCALE_MODELS, DEFAULT_UPSCALE_CONFIG } from "./upscaler/protocols";
import { BUILTIN_ERASER_MODELS, DEFAULT_INPAINT_ERASER_CONFIG } from "./inpaint/eraser/protocols";

type SettingsTab = "upscaler" | "bg-removal" | "segmentation" | "inpaint-eraser";

const TABS: { value: SettingsTab; label: string; icon: typeof Cpu }[] = [
  { value: "upscaler", label: "Upscaler", icon: ArrowUpRight },
  { value: "bg-removal", label: "BG Remover", icon: Cpu },
  { value: "segmentation", label: "Segmentation", icon: Shapes },
  { value: "inpaint-eraser", label: "Smart Eraser", icon: Eraser },
];

/** Map the drawer's activeTool (persisted in config) to a settings tab */
function toolToTab(activeTool: string | undefined): SettingsTab {
  if (activeTool === 'upscaler') return 'upscaler';
  if (activeTool === 'segmentation') return 'segmentation';
  if (activeTool === 'bg-removal') return 'bg-removal';
  if (activeTool === 'inpaint-eraser') return 'inpaint-eraser';
  return 'upscaler';
}

export function AIToolsSettings() {
  const [config] = usePluginSelfConfig<Record<string, unknown>>();
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => toolToTab(config?.activeTool as string | undefined));
  const { task, isDownloading } = useDownloadTask();

  // Determine which tab the current download belongs to
  const downloadingTab = useMemo<SettingsTab | null>(() => {
    if (!isDownloading || !task) return null;
    const downloadModelId = task.modelId;
    const bgModels = (config?.bgremover as ModelCatalog | undefined)?.models ?? BUILTIN_MODELS;
    if (bgModels.some(m => m.modelId === downloadModelId)) return "bg-removal";
    const upModels = (config?.upscale as UpscaleConfig | undefined)?.models ?? BUILTIN_UPSCALE_MODELS;
    if (upModels.some(m => m.modelId === downloadModelId)) return "upscaler";
    const segModels = (config?.seg as SegConfig | undefined)?.models ?? BUILTIN_SEG_MODELS;
    if (segModels.some(m => m.modelId === downloadModelId)) return "segmentation";
    const eraserModels = (config?.inpaintEraser as InpaintEraserConfig | undefined)?.models ?? BUILTIN_ERASER_MODELS;
    if (eraserModels.some(m => m.modelId === downloadModelId)) return "inpaint-eraser";
    return null;
  }, [isDownloading, task, config]);

  // Detect which tabs have custom (non-builtin) models
  const customModelTabs = useMemo<Set<SettingsTab>>(() => {
    const tabs = new Set<SettingsTab>();
    const bgModels = (config?.bgremover as ModelCatalog | undefined)?.models ?? BUILTIN_MODELS;
    if (bgModels.some(m => !m.builtin)) tabs.add("bg-removal");
    const upModels = (config?.upscale as UpscaleConfig | undefined)?.models ?? BUILTIN_UPSCALE_MODELS;
    if (upModels.some(m => !m.builtin)) tabs.add("upscaler");
    const segModels = (config?.seg as SegConfig | undefined)?.models ?? BUILTIN_SEG_MODELS;
    if (segModels.some(m => !m.builtin)) tabs.add("segmentation");
    const eraserModels = (config?.inpaintEraser as InpaintEraserConfig | undefined)?.models ?? BUILTIN_ERASER_MODELS;
    if (eraserModels.some(m => !m.builtin)) tabs.add("inpaint-eraser");
    return tabs;
  }, [config]);

  return (
    <div className="flex flex-col gap-4">
      {/* ─── Segment Control (Pill Toggle) ────────────────────── */}
      <div className="flex gap-0.5 p-0.5 rounded-lg bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.value;
          const hasCustom = customModelTabs.has(tab.value);
          return (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              className={`flex-1 relative flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all duration-150 ${
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

      {/* ─── Tab Content (declarative ModelSettings) ───────────── */}
      {activeTab === "bg-removal" && (
        <ModelSettings<ModelEntry>
          configKey="bgremover"
          defaultConfig={DEFAULT_BG_REMOVAL_CONFIG}
          builtins={BUILTIN_MODELS}
          defaultNewModel={() => ({
            id: `custom-${Date.now()}`,
            name: 'Custom Model',
            modelId: '',
            size: 'Unknown',
            description: 'User-added custom model',
            builtin: false,
          })}
          getFiles={(m) => [{ filename: m.onnxFile ?? 'onnx/model.onnx', expectedBytes: m.expectedBytes }]}
          fileFields={[{ key: 'onnxFile', label: 'ONNX', placeholder: 'onnx/model.onnx' }]}
          customModelHint="Repo must contain preprocessor_config.json + config.json"
        />
      )}

      {activeTab === "upscaler" && (
        <ModelSettings<UpscaleModelEntry>
          configKey="upscale"
          defaultConfig={DEFAULT_UPSCALE_CONFIG}
          builtins={BUILTIN_UPSCALE_MODELS}
          defaultNewModel={() => ({
            id: `custom-${Date.now()}`,
            name: 'Custom Upscale Model',
            modelId: '',
            size: 'Unknown',
            scale: 4,
            description: 'User-added custom upscale model',
            builtin: false,
          })}
          getFiles={(m) => [{ filename: m.onnxFile ?? 'model.onnx' }]}
          getBadge={(m) => `${m.scale}×`}
          fileFields={[{ key: 'onnxFile', label: 'ONNX', placeholder: 'model.onnx' }]}
        />
      )}

      {activeTab === "segmentation" && (
        <ModelSettings<SegModelEntry>
          configKey="seg"
          defaultConfig={DEFAULT_SEG_CONFIG}
          builtins={BUILTIN_SEG_MODELS}
          defaultNewModel={() => ({
            id: `custom-seg-${Date.now()}`,
            name: 'Custom SAM Model',
            modelId: '',
            size: 'Unknown',
            description: 'User-added custom segmentation model',
            builtin: false,
            type: 'interactive' as const,
          })}
          getFiles={(m) => getSegModelFiles(m)}
          getBadge={(m) => m.type === 'auto' ? 'Auto' : 'Interactive'}
          fileFields={[
            { key: 'encoderFile', label: 'Encoder', placeholder: DEFAULT_SEG_ENCODER_FILE },
            { key: 'decoderFile', label: 'Decoder', placeholder: DEFAULT_SEG_DECODER_FILE },
          ]}
        />
      )}

      {activeTab === "inpaint-eraser" && (
        <ModelSettings<InpaintEraserModelEntry>
          configKey="inpaintEraser"
          defaultConfig={DEFAULT_INPAINT_ERASER_CONFIG}
          builtins={BUILTIN_ERASER_MODELS}
          defaultNewModel={() => ({
            id: `custom-${Date.now()}`,
            name: 'Custom Inpaint Model',
            modelId: '',
            size: 'Unknown',
            description: 'User-added custom inpainting model',
            builtin: false,
            inputSize: 512,
          })}
          getFiles={(m) => [{ filename: m.onnxFile ?? 'lama_fp32.onnx', expectedBytes: m.expectedBytes }]}
          fileFields={[
            { key: 'onnxFile', label: 'ONNX', placeholder: 'lama_fp32.onnx', suffix: (m) => `${m.inputSize}×${m.inputSize}` },
          ]}
          customModelHint="Model must accept [1, 3, H, W] image + [1, 1, H, W] mask inputs"
        />
      )}

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
