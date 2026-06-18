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

import React, { useState } from "react";
import {
  Settings,
  Dice5,
  Image as ImageIcon,
  AlertTriangle,
  Trash,
  ChevronDown,
  RefreshCw,
  Layers,
  Sparkles,
  PenTool,
  Shuffle,
  Clock,
} from "lucide-react";
import FunctionButton from "@opengpex/editor/widgets/FunctionButton";
import ActionButton from "@opengpex/editor/widgets/ActionButton";
import ActionDropdown from "@opengpex/editor/widgets/ActionDropdown";
import Switch from "@opengpex/editor/widgets/Switch";
import { useAIBridgeState } from "./hooks";
import { usePluginSignals } from "@opengpex/editor/core/context";
import { AIBridgeConfig, AIMode, AI_MODE_META } from "./protocols";
import { AIBridgeHistory } from "./panels/history";

type DrawerTab = 'generate' | 'history';

const MODE_ICONS: Record<AIMode, React.ReactNode> = {
  generate: <Sparkles size={10} />,
  edit: <PenTool size={10} />,
  variations: <Shuffle size={10} />,
};

const SIZE_OPTIONS = [
  { label: "1024×1024", value: "1024x1024", description: "Square" },
  { label: "1024×1536", value: "1024x1536", description: "Portrait" },
  { label: "1536×1024", value: "1536x1024", description: "Landscape" },
  { label: "Auto", value: "auto", description: "Let model decide" },
];

const MODE_LIST: AIMode[] = ['generate', 'edit', 'variations'];

/**
 * AIGenerationDrawer: AI image generation drawer panel
 * Presentation component only, all business logic delegated to hooks.ts and commands.ts.
 * Supports Generate / Edit / Variations modes and dynamic model selection.
 */
export const AIGenerationDrawer = React.memo(function AIGenerationDrawer() {
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('generate');
  const {
    config,
    activeProvider,
    canGenerate,
    needsSetup,
    mode,
    hasActiveLayer,
    needsSourceImage,
    cachedModels,
    isFetchingModels,
    fetchModelError,
    isModelFilterFallback,
    updateConfig,
    setMode,
    setModel,
    fetchModels,
    generateCmd,
    openSettingsCmd,
  } = useAIBridgeState();

  // Reads generating state signal via usePluginSignals — not lost even if drawer is closed and reopened
  const { isGeneratingSignal } = usePluginSignals();
  const isGenerating = Boolean(isGeneratingSignal?.value);
  const [showNegative, setShowNegative] = useState(Boolean(config.negativePrompt));

  // Check if history has records
  const historyCount = (config as AIBridgeConfig & { generationHistory?: unknown[] }).generationHistory?.length || 0;
  const hasHistory = historyCount > 0;

  const handleGenerate = async () => {
    try {
      await generateCmd?.execute();
    } catch {
      // Error already handled inside command (HUD message shown)
    }
  };

  // ─── Setup Screen ────────────────────────────────────────────────────────────

  if (needsSetup && drawerTab === 'generate') {
    return (
      <div className="flex flex-col gap-2 px-2 pt-1 pb-1 h-full">
        <div className="flex flex-col items-center justify-center h-full p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-center">
          <AlertTriangle size={24} className="text-rose-500 mb-2 opacity-80" />
          <p className="text-[10px] font-bold text-[var(--text-main)] mb-1">
            API Key Missing
          </p>
          <p className="text-[9px] text-[var(--text-muted)] mb-4 px-2 leading-relaxed">
            Configure your AI endpoint and key in Settings to start generating images.
          </p>
          <FunctionButton
            onClick={() => openSettingsCmd?.execute()}
            variant="glass"
            className="w-full !bg-indigo-600 hover:!bg-indigo-500 !text-white !border-none h-8 text-[10px] font-bold focus:outline-none"
          >
            <Settings size={12} className="mr-1" /> Go to Settings
          </FunctionButton>

          <div className="mt-4 pt-4 border-t border-rose-500/20 w-full flex flex-col items-center gap-2">
            <span className="text-[8px] text-[var(--text-muted)] uppercase tracking-widest font-black">
              Or try it for free
            </span>
            <button
              onClick={() => updateConfig({ isMockMode: true })}
              className="text-[9px] font-bold text-rose-500 hover:text-rose-400 transition-colors focus:outline-none"
            >
              Enable Developer Mock Mode
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Main Drawer ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-2 px-2 pt-1 pb-1">
      {/* Header (always visible) */}
      <div className="flex justify-between items-center mb-1 shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-black text-[12px] uppercase leading-none text-indigo-500 opacity-80 px-[1px]">
            AI
          </span>
          {config.isMockMode || config.providers.length <= 1 ? (
            <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-muted)]">
              {config.isMockMode ? "Mock Generator" : activeProvider?.name || "AI Generation"}
            </span>
          ) : (
            <ActionDropdown
              options={config.providers.map((p) => ({ label: p.name, value: p.id }))}
              onSelect={(val) => updateConfig({ activeProviderId: val })}
              trigger={(isOpen) => (
                <div className="flex items-center gap-1 group cursor-pointer">
                  <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-main)] group-hover transition-colors">
                    {activeProvider?.name || "Select Provider"}
                  </span>
                  <ChevronDown
                    size={10}
                    className={`text-[var(--text-muted)] transition-transform duration-200 group-hover ${isOpen ? "rotate-180" : ""}`}
                  />
                </div>
              )}
            />
          )}
        </div>
        <ActionButton
          onClick={() => openSettingsCmd?.execute()}
          icon={<Settings size={12} />}
          tooltip="AI Settings"
          size="sm"
          variant="glass"
        />
      </div>

      {/* History View */}
      {drawerTab === 'history' && (
        <>
          <AIBridgeHistory />
          <div className="pt-2">
            <FunctionButton
              onClick={() => setDrawerTab('generate')}
              variant="ghost"
              className="w-full h-8 text-[9px] gap-1.5 !bg-[var(--bg-stage)] border !border-[var(--border-subtle)] !text-[var(--text-main)] hover:!border-indigo-500/50 transition-all focus:outline-none"
            >
              <Clock size={11} />
              <span className="uppercase font-bold tracking-wider">Close History</span>
            </FunctionButton>
          </div>
        </>
      )}

      {/* Generate Content */}
      {drawerTab === 'generate' && <>
      <div className="space-y-2">
        {/* Mode Tabs */}
        <div className="flex bg-[var(--bg-stage)] rounded-lg border border-[var(--border-subtle)] p-0.5">
          {MODE_LIST.map((m) => {
            const meta = AI_MODE_META[m];
            const isActive = mode === m;
            return (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md text-[9px] font-black uppercase tracking-wider transition-all focus:outline-none ${
                  isActive
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
                }`}
              >
                {MODE_ICONS[m]}
                <span>{meta.label}</span>
              </button>
            );
          })}
        </div>

        {/* Model Selector */}
        {!config.isMockMode && (
          <div className="flex items-center gap-1.5 px-1">
            <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight w-10 shrink-0">
              Model
            </span>
            <div className="flex-1 min-w-0">
              {cachedModels.length > 0 ? (
                <ActionDropdown
                  options={cachedModels.map((m) => ({ label: m.id, value: m.id }))}
                  onSelect={(val) => setModel(val)}
                  align="left"
                  trigger={() => (
                    <FunctionButton variant="glass" className="h-6 text-[9px] px-2 gap-1 w-full justify-between">
                      <span className="truncate">{activeProvider?.model || "Select model"}</span>
                      <ChevronDown size={8} className="opacity-50 shrink-0" />
                    </FunctionButton>
                  )}
                />
              ) : (
                <input
                  type="text"
                  value={activeProvider?.model ?? ''}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="e.g. gpt-image-1"
                  className="flex-1 w-full bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-md px-2 py-1 text-[9px] text-[var(--text-main)] focus:outline-none focus:border-indigo-500"
                />
              )}
            </div>
            <button
              onClick={fetchModels}
              disabled={isFetchingModels}
              title="Fetch available models"
              className={`p-1.5 rounded-md transition-colors focus:outline-none ${
                isFetchingModels
                  ? "text-indigo-500"
                  : "text-[var(--text-muted)] hover:text-indigo-500"
              }`}
            >
              <RefreshCw size={11} className={isFetchingModels ? "animate-spin" : ""} />
            </button>
          </div>
        )}

        {/* Fetch Model Error */}
        {fetchModelError && (
          <div className="px-2 py-1.5 bg-rose-500/10 border border-rose-500/20 rounded-lg">
            <p className="text-[8px] text-rose-500 font-bold">{fetchModelError}</p>
          </div>
        )}

        {/* No Image Models Detected Notice */}
        {isModelFilterFallback && cachedModels.length > 0 && (
          <div className="px-2 py-1.5 bg-amber-500/10 border border-amber-500/20 rounded-lg">
            <p className="text-[8px] text-amber-600 font-bold">
              No image models detected. Showing all available models.
            </p>
          </div>
        )}

        {/* Source Image Notice (for Edit/Variations) */}
        {needsSourceImage && (
          <div className={`flex items-center gap-2 px-2.5 py-2 rounded-xl border ${
            hasActiveLayer
              ? "bg-emerald-500/5 border-emerald-500/20"
              : "bg-amber-500/10 border-amber-500/20"
          }`}>
            <Layers size={12} className={hasActiveLayer ? "text-emerald-500" : "text-amber-500"} />
            <span className={`text-[9px] font-bold ${hasActiveLayer ? "text-emerald-600" : "text-amber-600"}`}>
              {hasActiveLayer
                ? "Using active layer as source image"
                : "Select an image layer first"
              }
            </span>
          </div>
        )}

        {/* Prompt Area (shown for Generate and Edit modes) */}
        {(mode === 'generate' || mode === 'edit') && (
          <div className="flex flex-col bg-[var(--bg-stage)] p-2 rounded-xl border border-[var(--border-subtle)] focus-within:border-indigo-500/50 transition-colors">
            <div className="flex items-center justify-between mb-1.5 px-1">
              <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight">
                Prompt
              </span>
              {config.prompt.length > 0 && (
                <button
                  onClick={() => updateConfig({ prompt: "" })}
                  className="text-[var(--text-muted)] hover:text-rose-500 transition-colors p-0.5 focus:outline-none"
                  title="Clear text"
                >
                  <Trash size={10} />
                </button>
              )}
            </div>
            <textarea
              value={config.prompt}
              onChange={(e) => updateConfig({ prompt: e.target.value })}
              placeholder={mode === 'edit'
                ? "Describe the changes you want to make..."
                : "A cinematic shot of a cyberpunk city..."
              }
              className="w-full h-24 bg-transparent border-none text-[11px] text-[var(--text-main)] resize-none focus:outline-none placeholder:text-[var(--text-muted)] leading-relaxed px-1"
            />

            {/* Negative prompt toggle (only for generate mode) */}
            {mode === 'generate' && (
              <>
                <div className="flex justify-end pt-1">
                  <button
                    onClick={() => setShowNegative(!showNegative)}
                    className="text-[8px] font-bold text-[var(--text-muted)] hover transition-colors uppercase tracking-widest focus:outline-none"
                  >
                    {showNegative ? "- Hide Negative Prompt" : "+ Add Negative Prompt"}
                  </button>
                </div>

                {showNegative && (
                  <div className="mt-2 pt-2 border-t border-[var(--border-subtle)]">
                    <div className="flex items-center justify-between mb-1.5 px-1">
                      <span className="text-[8px] font-black text-rose-500/80 uppercase tracking-tight">
                        Negative Prompt
                      </span>
                    </div>
                    <textarea
                      value={config.negativePrompt}
                      onChange={(e) => updateConfig({ negativePrompt: e.target.value })}
                      placeholder="ugly, blurry, bad anatomy..."
                      className="w-full h-16 bg-transparent border-none text-[11px] text-[var(--text-main)] resize-none focus:outline-none placeholder:text-[var(--text-muted)] leading-relaxed px-1"
                    />
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Controls: Size / Seed / Mock */}
        <div className="flex flex-col gap-2 px-1">
          {/* Size */}
          <div className="flex items-center justify-between">
            <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight w-10">
              Size
            </span>
            <ActionDropdown
              options={SIZE_OPTIONS}
              onSelect={(val) => updateConfig({ size: val as AIBridgeConfig['size'] })}
              align="right"
              trigger={() => (
                <FunctionButton variant="glass" className="h-6 text-[9px] px-2 gap-1">
                  {config.size} <ChevronDown size={8} className="opacity-50" />
                </FunctionButton>
              )}
            />
          </div>

          {/* Seed (only for generate mode) */}
          {mode === 'generate' && (
            <div className="flex items-center justify-between">
              <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight w-10">
                Seed
              </span>
              <div className="flex items-center flex-1 gap-1">
                <input
                  type="number"
                  value={config.seed}
                  onChange={(e) => updateConfig({ seed: parseInt(e.target.value) || -1 })}
                  placeholder="-1 (Random)"
                  className="flex-1 bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-md px-2 py-1 text-[10px] text-[var(--text-main)] focus:outline-none focus:border-indigo-500"
                />
                <button
                  onClick={() => updateConfig({ seed: Math.floor(Math.random() * 1000000000) })}
                  title="Randomize Seed"
                  className="p-1.5 text-[var(--text-muted)] hover:text-indigo-500 transition-colors focus:outline-none"
                >
                  <Dice5 size={12} />
                </button>
              </div>
            </div>
          )}

          {/* Mock Mode Toggle */}
          <div className="flex items-center justify-between pt-1 mt-1 border-t border-[var(--border-subtle)]">
            <span className="text-[8px] font-black text-amber-600 uppercase tracking-tight">
              Mock Mode
            </span>
            <Switch
              checked={config.isMockMode}
              onChange={(v) => updateConfig({ isMockMode: v })}
              activeColor="bg-amber-500"
            />
          </div>
        </div>

        {/* Generate + History Buttons */}
        <div className="pt-2 flex gap-1.5">
          <FunctionButton
            onClick={handleGenerate}
            disabled={!canGenerate}
            loading={isGenerating}
            variant="ghost"
            className={`flex-[2] h-9 text-[10px] gap-1.5 !text-white transition-all shadow-md focus:outline-none
 ${isGenerating
    ? "!bg-indigo-400 border !border-indigo-400/20"
    : "!bg-indigo-600 hover:!bg-indigo-500 border !border-indigo-400/20"
 }
`}
          >
            {!isGenerating && <ImageIcon size={12} className="opacity-80" />}
            <span className="uppercase font-bold tracking-wider">
              {isGenerating
                ? "Processing..."
                : mode === 'generate' ? "Generate"
                : mode === 'edit' ? "Edit"
                : "Vary"
              }
            </span>
          </FunctionButton>
          <FunctionButton
            onClick={() => setDrawerTab('history')}
            disabled={!hasHistory}
            variant="ghost"
            className="flex-[1] h-9 text-[9px] gap-1 !bg-[var(--bg-stage)] border !border-[var(--border-subtle)] !text-[var(--text-muted)] hover:!text-[var(--text-main)] hover:!border-indigo-500/30 transition-all focus:outline-none disabled:opacity-40"
          >
            <Clock size={11} />
            <span className="uppercase font-bold tracking-wider">History</span>
          </FunctionButton>
        </div>
      </div>
      </>}
    </div>
  );
});
