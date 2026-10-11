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

'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { Settings, ChevronDown } from 'lucide-react';
import { motion } from 'framer-motion';
import { useEditorState, useEditorServices, usePluginCommands, usePluginSelfConfig } from '@opengpex/editor/core/context';
import ActionDropdown from '@opengpex/editor/widgets/ActionDropdown';
import { initBusySync } from './_shared';
import { bgRemoverStore } from './bgremover/store';
import { segStore } from './segmentation/store';
import { upscaleStore } from './upscaler/store';
import { inpaintEraserStore } from './inpaint/eraser/store';
import { AIToolsIcon } from './icon';
import { BgRemoverPanel } from './bgremover/components/panel';
import { UpscalerPanel } from './upscaler/components/panel';
import { SegmentationPanel } from './segmentation/components/panel';
import { InpaintEraserPanel } from './inpaint/eraser/components/panel';
import type { AIToolsDrawerCommandsMap } from './commands.d';
import { AIToolsDrawerAPI } from './protocols';
import { ClipOptionsAPI } from '../../options/ClipOptions/protocols';

// ─── Tool definitions ────────────────────────────────────────────────────────

type AITool = 'upscaler' | 'bg-removal' | 'segmentation' | 'inpaint-eraser';

const AI_TOOLS: { value: AITool; label: string; description: string }[] = [
  { value: 'upscaler', label: 'Upscaler', description: 'Enhance image resolution with AI' },
  { value: 'bg-removal', label: 'BG Remover', description: 'Remove image backgrounds using AI' },
  { value: 'segmentation', label: 'Segmentation', description: 'Click to select objects using SAM' },
  { value: 'inpaint-eraser', label: 'Smart Eraser', description: 'Remove objects and fill with AI' },
];

// ─── Main Component ──────────────────────────────────────────────────────────

export function AIToolsDrawerContent() {
  const { openSettingsCmd } = usePluginCommands<AIToolsDrawerCommandsMap>();
  const { state, activeFrame } = useEditorState();
  const { actions, plugins } = useEditorServices();
  const [config, setConfig] = usePluginSelfConfig<Record<string, unknown>>();
  // True while any AI tool has an in-flight task — blocks tool switching so
  // exiting clip mode can't tear down a running SAM session mid-inference.
  const [anyToolBusy, setAnyToolBusy] = useState(false);

  // Persist active tool selection in config so it survives page refresh
  const savedTool = (config?.activeTool as AITool) || 'upscaler';
  const [userSelectedTool, setUserSelectedTool] = useState<AITool>(savedTool);

  const isClipSam = state.interaction.interactionMode === 'clip' && activeFrame?.latestClipTool === 'sam';

  const handleToolSelect = useCallback((val: string) => {
    const tool = val as AITool;
    // Switching away from Segmentation while the SAM clip tool is active
    // first exits clip mode (via the standard exitClip command so peel/
    // exchange teardown stays in one place). The forced segmentation
    // binding below rolls the tab back if the exit didn't land (e.g. the
    // Re-Canvas branch of exitClip only closes Re-Canvas).
    if (isClipSam && tool !== 'segmentation') {
      void actions.executeCommand(ClipOptionsAPI.commands.exitClip.uid);
    }
    setUserSelectedTool(tool);
    setConfig({ activeTool: tool });
  }, [isClipSam, actions, setConfig]);

  // One-time: give the download singleton a reference to PluginService
  // so it can auto-sync busy state even after this component unmounts.
  // Use a unified busy sync that OR-combines all stores + download state.
  useEffect(() => {
    const uid = AIToolsDrawerAPI.configKey;
    initBusySync(plugins, uid);

    // Unified busy sync: busy = any store has a task OR download is active
    const syncBusy = () => {
      const isBusy =
        bgRemoverStore.getState().task !== null ||
        segStore.getState().task !== null ||
        upscaleStore.getState().task !== null ||
        inpaintEraserStore.getState().task !== null;
      plugins.setBusy(uid, isBusy);
      setAnyToolBusy(isBusy);
    };

    const unsubs = [
      bgRemoverStore.subscribe(syncBusy),
      segStore.subscribe(syncBusy),
      upscaleStore.subscribe(syncBusy),
      inpaintEraserStore.subscribe(syncBusy),
    ];

    // Initial sync
    syncBusy();

    return () => { unsubs.forEach(fn => fn()); };
  }, [plugins]);

  // While the SAM clip tool is active the Segmentation panel stays in front
  // (results render there); switching to another tool exits clip mode first
  // (see handleToolSelect).
  const activeTool: AITool = isClipSam ? 'segmentation' : userSelectedTool;

  // Sync active tab to a state signal so autoReveal.when() can read it
  useEffect(() => {
    actions.setStateSignal(AIToolsDrawerAPI.signals.activeTab, activeTool);
  }, [activeTool, actions]);


  const handleOpenSettings = useCallback(() => {
    openSettingsCmd?.execute();
  }, [openSettingsCmd]);

  const activeToolMeta = AI_TOOLS.find(t => t.value === activeTool) || AI_TOOLS[0];

  return (
    <div className="flex flex-col gap-2 px-2 pt-1 pb-1">
      {/* ─── Header ──────────────────────────────────────────────── */}
      <motion.div layout="position" className="flex justify-between items-center h-6 shrink-0">
        <div className="flex items-center gap-2">
          <AIToolsIcon className="text-indigo-600 dark:text-indigo-400" />
          <ActionDropdown
            options={AI_TOOLS.map(t => ({
              value: t.value,
              label: t.label,
            }))}
            disabled={anyToolBusy}
            onSelect={handleToolSelect}
            trigger={(isOpen) => (
              <div className={`flex items-center gap-1 group cursor-pointer ${anyToolBusy ? 'opacity-60' : ''}`} title={anyToolBusy ? 'Tool switching unavailable while a task is running' : undefined}>
                <span className={`text-[10px] font-black uppercase tracking-[0.15em] transition-colors text-[var(--text-main)] group-hover`}>
                  {activeToolMeta.label}
                </span>
                <ChevronDown
                  size={10}
                  className={`text-[var(--text-muted)] transition-transform duration-200 group-hover ${isOpen ? 'rotate-180' : ''}`}
                />
              </div>
            )}
          />
        </div>
        <button
          onClick={handleOpenSettings}
          className="p-1 rounded hover:bg-white/5 text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors"
          title="Model Settings"
        >
          <Settings size={12} />
        </button>
      </motion.div>

      {/* ─── Active Tool Panel ──────────────────────────────────── */}
      {activeTool === 'bg-removal' && <BgRemoverPanel />}
      {activeTool === 'upscaler' && <UpscalerPanel />}
      {activeTool === 'segmentation' && <SegmentationPanel />}
      {activeTool === 'inpaint-eraser' && <InpaintEraserPanel />}
    </div>
  );
}
