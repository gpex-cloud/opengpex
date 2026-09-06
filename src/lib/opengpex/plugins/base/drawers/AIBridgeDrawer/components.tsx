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
  Dices,
  Image as ImageIcon,
  Camera,
  AlertTriangle,
  ChevronDown,
  RefreshCw,
  Sparkles,
  PenTool,
  Clock,
  Type,
  HelpCircle,
  MessageSquare,
  ScanSearch,
  Info,
} from "lucide-react";
import { motion } from "framer-motion";
import { AIBridgeIcon } from './icon';
import FancyButton from "@opengpex/editor/widgets/FancyButton";
import ActionButton from "@opengpex/editor/widgets/ActionButton";
import ActionDropdown from "@opengpex/editor/widgets/ActionDropdown";
import ComboInput from "@opengpex/editor/widgets/ComboInput";
import FunctionTabs from "@opengpex/editor/widgets/FunctionTabs";
import ComfyNumberInput from "@opengpex/editor/widgets/ComfyNumberInput";
import StatusBanner from "@opengpex/editor/widgets/StatusBanner";
import FancyTextArea from "@opengpex/editor/widgets/FancyTextArea";
import { useAIBridgeState } from "./hooks";
import { usePluginSelfBusy, useEditorState } from "@opengpex/editor/core/context";
import { AIMode, AIModelInfo, ModelModality, AI_MODE_META } from "./protocols";
import { InputSourceSelector } from "@opengpex/editor/plugins/base/drawers/ComfyBridgeDrawer/components/workflower";
import { AIBridgeHistory } from "./panels/history";

type DrawerTab = "generate" | "history";
const MODE_ICONS: Record<AIMode, React.ReactNode> = {
  describe: <MessageSquare size={10} />,
  generate: <Sparkles size={10} />,
  edit: <PenTool size={10} />,
};

const SIZE_OPTIONS: string[] = [
  "1024x1024",
];
const MODE_LIST: AIMode[] = ["describe", "generate", "edit"];

/** Modality badge: image / multi / text / unknown.
 *  Purely informational — it never disables an action, because modality is
 *  inferred and a wrong guess must not stand in the user's way.
 *  Monochrome (inherits the row's text color) so the list stays calm.
 *  Note: ActionDropdown renders option icons at scale-90, so 13 lands at ~12px
 *  inside the list while staying proportionate in the trigger button. */
function ModalityBadge({ modality }: { modality: ModelModality | undefined }) {
  if (modality === 'image') {
    return <Camera size={13} className="shrink-0" />;
  }
  if (modality === 'multi') {
    return <ImageIcon size={13} className="shrink-0" />;
  }
  if (modality === 'text') {
    return <Type size={13} className="shrink-0" />;
  }
  return <HelpCircle size={13} className="shrink-0" />;
}

/** Icon shown in the ActionOption list next to the model name */
function modalityOptionIcon(m: AIModelInfo): React.ReactNode {
  return <ModalityBadge modality={m.modality} />;
}

/**
 * AIGenerationDrawer: AI image generation drawer panel
 * Presentation component only, all business logic delegated to hooks.ts and commands.ts.
 * Supports Generate / Edit modes and dynamic model selection.
 */
export const AIGenerationDrawer = React.memo(function AIGenerationDrawer() {
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("generate");
  const {
    config,
    activeEndpoint,
    canGenerate,
    needsSetup,
    mode,
    inputSource,
    needsSourceImage,
    cachedModels,
    activeModel,
    activeModality,
    modelHint,
    capabilities,
    features,
    isFetchingModels,
    fetchModelError,
    updateConfig,
    setMode,
    setModel,
    setActiveEndpoint,
    setInputSource,
    fetchModels,
    generateCmd,
    describeCmd,
    openSettingsCmd,
  } = useAIBridgeState();

  // Feature-driven control visibility (declared by provider preset)
  const showNegativePrompt = features.negativePrompt !== false;
  const showSize = features.size !== false;
  const showSeed = features.seed !== false;

  // Frame existence gates the input source (ComfyBridge InputSourceSelector shows amber when absent)
  const { activeFrame } = useEditorState();

  // Reads generating state via usePluginSelfBusy (derived from PluginService.isBusy) — not lost even if drawer is closed and reopened
  const isGenerating = usePluginSelfBusy();
  const [showNegative, setShowNegative] = useState(
    Boolean(config.negativePrompt),
  );

  // Check if history has records
  const hasHistory = config.generationHistory?.length > 0;

  // History view inherits the mode the user opened it from (describe/generate/edit)
  const [historyFromMode, setHistoryFromMode] = useState<AIMode>('generate');
  const openHistory = () => {
    setHistoryFromMode(mode);
    setDrawerTab('history');
  };

  // Describe (image → prompt): local loading + result; FancyTextArea handles copy
  const [isDescribing, setIsDescribing] = useState(false);
  const [description, setDescription] = useState('');
  const handleDescribe = async () => {
    setIsDescribing(true);
    setDescription('');
    try {
      const result = await describeCmd?.execute() as { success: boolean; description?: string; error?: string } | undefined;
      if (result?.success && result.description) {
        setDescription(result.description);
      }
    } catch {
      // HUD already shown by command
    } finally {
      setIsDescribing(false);
    }
  };

  const handleGenerate = async () => {
    try {
      await generateCmd?.execute();
    } catch {
      // Error already handled inside command (HUD message shown)
    }
  };

  // ─── Setup Screen (rendered inline below header) ──────────────────────────────

  const setupContent = needsSetup && drawerTab === "generate" && (
    <div className="flex flex-col items-center justify-center p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-center shrink-0">
      <AlertTriangle size={24} className="text-rose-500 mb-2 opacity-80" />
      <p className="text-[11px] font-bold text-[var(--text-main)] mb-1">
        API Key Missing
      </p>
      <p className="text-[10px] text-[var(--text-muted)] mb-2 px-2 leading-relaxed">
        Configure your AI endpoint and key in Settings to start generating
        images.
      </p>
      <p className="text-[10px] font-bold text-[var(--text-muted)] mb-4 px-2 leading-relaxed">
        🔒 Your API key is stored only in your browser&apos;s local storage
        and never sent to our servers.
      </p>
      <FancyButton
        onClick={() => openSettingsCmd?.execute()}
        variant="blue"
        size="xs"
        className="w-full focus:outline-none"
      >
        <Settings size={12} className="mr-1" /> Go to Settings
      </FancyButton>
    </div>
  );

  // ─── Main Drawer ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-2 px-2 pt-1 pb-1 overflow-hidden">
      {/* Header (always visible) */}
      <motion.div layout="position" className="flex justify-between items-center shrink-0">
        <div className="flex items-center gap-2">
          <AIBridgeIcon className="text-indigo-600 dark:text-indigo-400" />
          {config.endpoints.length <= 1 ? (
            <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-muted)]">
              {activeEndpoint?.name || "AI Generation"}
            </span>
          ) : (
            <ActionDropdown
              options={config.endpoints.map((e) => ({
                label: e.name,
                value: e.id,
              }))}
              onSelect={setActiveEndpoint}
              trigger={(isOpen) => (
                <div className="flex items-center gap-1 group cursor-pointer">
                  <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-main)] group-hover transition-colors">
                    {activeEndpoint?.name || "Select Endpoint"}
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
      </motion.div>

      {/* Setup Screen (key missing) - shown below header so user can still switch providers */}
      {setupContent}

      {/* History View (filtered by the mode the user came from) */}
      {drawerTab === "history" && (
        <>
          <AIBridgeHistory filterMode={historyFromMode} />
          <div className="pt-2">
            <FancyButton
              onClick={() => setDrawerTab("generate")}
              variant="zinc"
              subtle={true}
              size="xs"
              className="w-full hover:border-blue-500/50 bg-[var(--bg-stage)] border-[var(--border-subtle)] text-[var(--text-main)] focus:outline-none"
            >
              <Clock size={11} />
              <span className="uppercase font-bold tracking-wider">
                Close
              </span>
            </FancyButton>
          </div>
        </>
      )}

      {/* Generate Content */}
      {drawerTab === "generate" && !needsSetup && (
        <>
          <motion.div layout="position" className="space-y-2">
            {/* Mode Tabs — a tab is disabled when the selected provider has no
                such API at all (e.g. Anthropic/Ollama cannot generate images),
                so the limitation is visible before spending a request. */}
            <FunctionTabs
              options={MODE_LIST.map((m) => ({
                value: m,
                label: AI_MODE_META[m].label,
                icon: MODE_ICONS[m],
                disabled: !capabilities[m],
                tooltip: capabilities[m]
                  ? undefined
                  : `${activeEndpoint?.name ?? 'This provider'} does not offer ${AI_MODE_META[m].label.toLowerCase()}`,
              }))}
              value={mode}
              onChange={setMode}
              size="sm"
            />

            {/* Model Selector */}
            <div className="flex items-center gap-1.5 px-1">
                <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight w-10 shrink-0">
                  Model
                </span>
                <div className="flex-1 min-w-0">
                  {cachedModels.length > 0 ? (
                    <ActionDropdown
                      className="w-full block [&>div]:w-full"
                      matchTriggerWidth={true}
                      options={cachedModels.map((m) => ({
                        label: m.id,
                        value: m.id,
                        icon: modalityOptionIcon(m),
                      }))}
                      onSelect={(val) => setModel(val)}
                      align="left"
                      trigger={() => (
                        <FancyButton
                          variant="zinc"
                          subtle={true}
                          size="xs"
                          className="px-2 gap-1 w-full justify-between h-6"
                        >
                          <span className="flex items-center gap-1 min-w-0">
                            <ModalityBadge modality={activeModality} />
                            <span className="truncate">
                              {activeModel || "Select model"}
                            </span>
                          </span>
                          <ChevronDown
                            size={8}
                            className="opacity-50 shrink-0"
                          />
                        </FancyButton>
                      )}
                    />
                  ) : (
                    <input
                      type="text"
                      value={activeModel}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder="e.g. gpt-image-1"
                      className="flex-1 w-full h-[26px] bg-[var(--bg-stage)] border border-[var(--border-subtle)] rounded-lg px-2 text-[10px] font-black text-[var(--text-main)] tabular-nums focus:outline-none focus:border-blue-500/50"
                    />
                  )}
                </div>
                <button
                  onClick={fetchModels}
                  disabled={isFetchingModels}
                  title="Fetch available models"
                  className={`p-1.5 rounded-md transition-colors focus:outline-none ${
                    isFetchingModels
                      ? "text-blue-400"
                      : "text-[var(--text-muted)] hover:text-blue-400"
                  }`}
                >
                  <RefreshCw
                    size={11}
                    className={isFetchingModels ? "animate-spin" : ""}
                  />
                </button>
              </div>

            {/* Fetch Model Error */}
            {fetchModelError && (
              <StatusBanner
                variant="rose"
                icon={<AlertTriangle size={14} />}
                title={fetchModelError}
              />
            )}

            {/* Soft modality hint — advisory only, the action stays enabled.
                Modality is inferred, so the server has the final say. */}
            {modelHint && (
              <div className="flex items-start gap-1 px-1">
                <Info size={9} className="text-amber-500 mt-0.5 shrink-0" />
                <span className="text-[9px] font-bold text-amber-500/90 leading-tight">
                  {modelHint}
                </span>
              </div>
            )}

            {/* Describe page: result display (readonly, user copies manually) */}
            {mode === "describe" && (
              <FancyTextArea
                value={description}
                label="Described"
                labelClassName="!text-emerald-500/80"
                placeholder="Press Describe to generate a prompt from the current image (uses the text/vision model)."
                height="h-[136px]"
                readonly
                actions={{ copy: true, collapsible: true }}
              />
            )}

            {/* Prompt Area (shown for Generate and Edit modes) */}
            {(mode === "generate" || mode === "edit") && (
              <div className="flex flex-col gap-2">
                <FancyTextArea
                  value={config.prompt}
                  onChange={(v) => updateConfig({ prompt: v })}
                  label="Prompt"
                  labelClassName="!text-emerald-500/80"
                  placeholder={mode === "edit" ? "Describe the changes you want to make..." : "A cinematic shot of a cyberpunk city..."}
                  height="h-48"
                  actions={{ copy: true, delete: true, collapsible: true }}
                />

                {showNegativePrompt && (
                  <div>
                    <div className="flex justify-end pb-1">
                      <button
                        onClick={() => setShowNegative(!showNegative)}
                        className="text-[8px] font-bold text-[var(--text-muted)] hover transition-colors uppercase tracking-widest focus:outline-none"
                      >
                        {showNegative
                          ? "- Hide Negative Prompt"
                          : "+ Add Negative Prompt"}
                      </button>
                    </div>

                    {showNegative && (
                      <FancyTextArea
                        value={config.negativePrompt}
                        onChange={(v) => updateConfig({ negativePrompt: v })}
                        label="Negative Prompt"
                        labelClassName="!text-rose-500/80"
                        placeholder="ugly, blurry, bad anatomy..."
                        height="h-[136px]"
                        actions={{ collapsible: true, delete: true }}
                        defaultCollapsed
                      />
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Controls: Size / Seed (Describe page has none) */}
            {mode !== "describe" && (
            <div className="flex flex-col gap-2 px-1">
              {/* Size (ComboInput: preset dropdown + free-form "WxH" input) — hidden when provider declares no size support */}
              {showSize && (
              <div className="flex items-center justify-between">
                <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight w-10">
                  Size
                </span>
                <ComboInput
                  type="text"
                  value={config.size || "1024x1024"}
                  options={SIZE_OPTIONS}
                  className="w-[120px] h-6 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-stage)] px-1"
                  onChange={(val) => {
                    // Dropdown option click → always valid, commit directly
                    updateConfig({ size: val });
                  }}
                  onCommit={(val) => {
                    // Free-typed input → validate as WxH before committing
                    const cleaned = val.trim().toLowerCase().replace(/\s*x\s*/g, 'x');
                    if (/^\d{2,4}x\d{2,4}$/.test(cleaned) || cleaned === 'auto') {
                      updateConfig({ size: cleaned });
                    }
                  }}
                />
              </div>
              )}

              {/* Seed (both modes; localai-refimages edit accepts seed. Hidden
                  when the provider preset declares no seed support) */}
              {showSeed && (
                <div className="flex items-center gap-1">
                  <div className="flex-1">
                    <ComfyNumberInput
                      label="Seed"
                      value={config.seed}
                      onChange={(v) => updateConfig({ seed: v })}
                      decimals={0}
                    />
                  </div>
                  <button
                    onClick={() =>
                      updateConfig({
                        seed: Math.floor(Math.random() * 1000000000),
                      })
                    }
                    title="Randomize Seed"
                    className="flex items-center justify-center w-[26px] h-[26px] rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-stage)] text-[var(--text-muted)] hover:text-blue-400 hover:border-blue-500/30 transition-colors shrink-0 focus:outline-none"
                  >
                    <Dices size={10} />
                  </button>
                </div>
              )}
            </div>
            )}

            {/* Primary + History Buttons */}
            <div className="pt-2 flex gap-1.5">
              {mode === "describe" ? (
                <FancyButton
                  onClick={handleDescribe}
                  disabled={!canGenerate}
                  loading={isGenerating || isDescribing}
                  variant="blue"
                  size="xs"
                  title={canGenerate ? undefined : 'Select a model and provide an image source first'}
                  className="flex-[2] focus:outline-none"
                >
                  {!isDescribing && <ScanSearch size={12} className="opacity-80" />}
                  <span className="uppercase font-bold tracking-wider">
                    {isDescribing ? "Describing..." : "Describe"}
                  </span>
                </FancyButton>
              ) : (
                <FancyButton
                  onClick={handleGenerate}
                  disabled={!canGenerate}
                  loading={isGenerating}
                  variant="blue"
                  size="xs"
                  title={modelHint ?? undefined}
                  className="flex-[2] focus:outline-none"
                >
                  {!isGenerating && (
                    <ImageIcon size={12} className="opacity-80" />
                  )}
                  <span className="uppercase font-bold tracking-wider">
                    {isGenerating
                      ? "Processing..."
                      : mode === "generate"
                        ? "Generate"
                        : "Edit"}
                  </span>
                </FancyButton>
              )}
              <FancyButton
                onClick={openHistory}
                disabled={!hasHistory}
                variant="zinc"
                subtle={true}
                size="xs"
                className="flex-[1] bg-[var(--bg-stage)] border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:border-blue-500/30 focus:outline-none disabled:opacity-40"
              >
                <Clock size={11} />
                <span className="uppercase font-bold tracking-wider">
                  History
                </span>
              </FancyButton>
            </div>

            {/* Input Source Selector (Edit + Describe) — placed at the
                bottom, matching ComfyBridgeDrawer's layout */}
            {needsSourceImage && (
              <InputSourceSelector
                inputSource={inputSource}
                hasFrame={Boolean(activeFrame)}
                disabled={isGenerating}
                onChangeSource={setInputSource}
              />
            )}
          </motion.div>
        </>
      )}
    </div>
  );
});
