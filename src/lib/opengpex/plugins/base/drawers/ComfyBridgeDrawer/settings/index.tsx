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

import React, { useState, useMemo } from 'react';
import { Link, FileJson } from 'lucide-react';
import { usePluginSelfConfig } from '@opengpex/editor/core/context';
import { ComfyBridgeConfig } from '../protocols';
import { EnvironmentsPanel } from './EnvironmentsPanel';
import { WorkflowsPanel } from './WorkflowsPanel';

// ─── Main Settings Component ───────────────────────────────────────────────────

export function ComfyBridgeSettings() {
  const [config, setConfig] = usePluginSelfConfig<ComfyBridgeConfig>();
  const [activeTab, setActiveTab] = useState<'environments' | 'workflows'>('workflows');

  const workflows = useMemo(() => config.workflows || [], [config.workflows]);

  return (
    <div className="flex flex-col gap-4">
      {/* ─── Segment Control (Pill Toggle) ────────────────────── */}
      <div className="flex gap-0.5 p-0.5 rounded-lg bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
        {([
          { value: 'environments' as const, label: 'Environments', icon: <Link size={10} /> },
          { value: 'workflows' as const, label: 'Workflows', icon: <FileJson size={10} /> },
        ]).map((tab) => {
          const isActive = activeTab === tab.value;
          return (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              className={`flex-1 relative flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all duration-150 ${
                isActive
                  ? 'bg-[var(--bg-panel)] text-[var(--text-main)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {tab.icon}
              {tab.label}
              {tab.value === 'workflows' && workflows.length > 0 && (
                <span className="text-[8px] opacity-60">({workflows.length})</span>
              )}
            </button>
          );
        })}
      </div>

      {/* ═══ Environments Tab ═══ */}
      {activeTab === 'environments' && (
        <EnvironmentsPanel config={config} setConfig={setConfig} />
      )}

      {/* ═══ Workflows Tab ═══ */}
      {activeTab === 'workflows' && (
        <WorkflowsPanel config={config} setConfig={setConfig} />
      )}
    </div>
  );
}
