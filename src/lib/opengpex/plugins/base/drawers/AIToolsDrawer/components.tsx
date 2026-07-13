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

import React, { useState, useCallback } from 'react';
import { Settings, ChevronDown } from 'lucide-react';
import { motion } from 'framer-motion';
import { usePluginCommands } from '@opengpex/editor/core/context';
import ActionDropdown from '@opengpex/editor/widgets/ActionDropdown';
import { AIToolsIcon } from './icon';
import { BgRemoverPanel } from './panels/bgremover';
import type { BgRemovalCommandsMap } from './commands.d';

// ─── Tool definitions ────────────────────────────────────────────────────────

type AITool = 'bg-removal';

const AI_TOOLS: { value: AITool; label: string; description: string }[] = [
  { value: 'bg-removal', label: 'Background Remover', description: 'Remove image backgrounds using AI' },
];

// ─── Main Component ──────────────────────────────────────────────────────────

export function BgRemovalDrawerContent() {
  const { openSettingsCmd } = usePluginCommands<BgRemovalCommandsMap>();
  const [activeTool, setActiveTool] = useState<AITool>('bg-removal');

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
            onSelect={(val) => setActiveTool(val as AITool)}
            trigger={(isOpen) => (
              <div className="flex items-center gap-1 group cursor-pointer">
                <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-main)] group-hover transition-colors">
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
    </div>
  );
}
