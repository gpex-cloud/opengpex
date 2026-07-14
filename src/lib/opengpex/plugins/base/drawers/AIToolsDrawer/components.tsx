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
import { useEditorState, useEditorServices, usePluginCommands } from '@opengpex/editor/core/context';
import ActionDropdown from '@opengpex/editor/widgets/ActionDropdown';
import { initBusySync } from './services';
import { AIToolsIcon } from './icon';
import { BgRemoverPanel } from './panels/bgremover';
import { SegmentationPanel } from './panels/segmentation';
import type { AIToolsDrawerCommandsMap } from './commands.d';
import { AIToolsDrawerAPI } from './protocols';

// ─── Tool definitions ────────────────────────────────────────────────────────

type AITool = 'bg-removal' | 'segmentation';

const AI_TOOLS: { value: AITool; label: string; description: string }[] = [
  { value: 'bg-removal', label: 'BG Remover', description: 'Remove image backgrounds using AI' },
  { value: 'segmentation', label: 'Segmentation', description: 'Click to select objects using SAM' },
];

// ─── Main Component ──────────────────────────────────────────────────────────


export function BgRemoverDrawerContent() {
  const { openSettingsCmd } = usePluginCommands<AIToolsDrawerCommandsMap>();
  const { state, activeFrame } = useEditorState();
  const { actions, plugins } = useEditorServices();
  const [userSelectedTool, setUserSelectedTool] = useState<AITool>('bg-removal');

  // One-time: give the download singleton a reference to PluginService
  // so it can auto-sync busy state even after this component unmounts.
  useEffect(() => {
    initBusySync(plugins, AIToolsDrawerAPI.configKey);
  }, [plugins]);

  // When SAM clip tool is active, force Segmentation panel (results appear there).
  // User must switch away from SAM to access BG Remover.
  const isClipSam = state.interaction.interactionMode === 'clip' && activeFrame?.latestClipTool === 'sam';
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
      <motion.div layout="position" className="flex justify-between items-center shrink-0">
        <div className="flex items-center gap-2">
          <AIToolsIcon className="text-indigo-600 dark:text-indigo-400" />
          <ActionDropdown
            options={AI_TOOLS.map(t => ({
              value: t.value,
              label: t.label,
            }))}
            disabled={isClipSam}
            onSelect={(val) => setUserSelectedTool(val as AITool)}
            trigger={(isOpen) => (
              <div className={`flex items-center gap-1 group ${isClipSam ? 'cursor-default' : 'cursor-pointer'}`} title={isClipSam ? 'Locked to Segmentation while SAM tool is active' : undefined}>
                <span className={`text-[10px] font-black uppercase tracking-[0.15em] transition-colors ${isClipSam ? 'text-indigo-500 dark:text-indigo-400' : 'text-[var(--text-main)] group-hover'}`}>
                  {activeToolMeta.label}
                </span>
                {!isClipSam && (
                  <ChevronDown
                    size={10}
                    className={`text-[var(--text-muted)] transition-transform duration-200 group-hover ${isOpen ? 'rotate-180' : ''}`}
                  />
                )}
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
      {activeTool === 'segmentation' && <SegmentationPanel />}
    </div>
  );
}
