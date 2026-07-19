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
import {
  Plus, Trash2, CheckCircle2, Link, Wifi,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import FancyButton from '@opengpex/editor/widgets/FancyButton';
import ActionDropdown from '@opengpex/editor/widgets/ActionDropdown';
import { ComfyBridgeConfig, ComfyEnvironment, ConnectionMode } from '../protocols';
import { ComfyClient } from '../api/client';

interface EnvironmentsPanelProps {
  config: ComfyBridgeConfig;
  setConfig: (patch: Partial<ComfyBridgeConfig>) => void;
}

export function EnvironmentsPanel({ config, setConfig }: EnvironmentsPanelProps) {
  const environments = config.environments || [];

  const [healthResults, setHealthResults] = useState<Record<string, { status: 'ok' | 'error'; info?: string; time?: number; nodeCount?: number }>>({});
  const [installedNodes, setInstalledNodes] = useState<Record<string, string[]>>({});
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [nodeSearch, setNodeSearch] = useState<Record<string, string>>({});
  const [checkingEnv, setCheckingEnv] = useState<string | null>(null);

  const updateEnv = useCallback((id: string, patch: Partial<ComfyEnvironment>) => {
    const next = environments.map(e => e.id === id ? { ...e, ...patch } : e);
    setConfig({ environments: next });
  }, [environments, setConfig]);

  const addEnv = useCallback(() => {
    const newEnv: ComfyEnvironment = {
      id: `env-${Date.now()}`,
      name: 'New Environment',
      url: 'http://localhost:8188',
      connectionMode: 'auto',
    };
    setConfig({ environments: [...environments, newEnv] });
  }, [environments, setConfig]);

  const removeEnv = useCallback((id: string) => {
    const next = environments.filter(e => e.id !== id);
    let nextActiveId = config.activeEnvironmentId;
    if (nextActiveId === id && next.length > 0) {
      nextActiveId = next[0].id;
    }
    setConfig({ environments: next, activeEnvironmentId: nextActiveId });
  }, [environments, config.activeEnvironmentId, setConfig]);

  const checkHealth = useCallback(async (env: ComfyEnvironment) => {
    setCheckingEnv(env.id);
    try {
      const client = new ComfyClient(env.url, env.connectionMode);
      const mode = client.resolvedMode;

      const [stats, nodes] = await Promise.all([
        client.getSystemStats(),
        client.getInstalledNodes().catch(() => [] as string[]),
      ]);

      if (nodes.length > 0) {
        setInstalledNodes(prev => ({ ...prev, [env.id]: nodes }));
      }

      const device = stats.devices?.[0];
      const nodeCountStr = nodes.length > 0 ? ` • ${nodes.length} nodes` : '';
      if (device) {
        const gpuName = device.name
          .replace(/^cuda:\d+\s*/, '')
          .replace(/\s*:\s*\w+$/, '')
          .trim() || device.name;
        const vramFreeGB = Math.round(device.vram_free / 1024 / 1024 / 1024);
        const vramTotalGB = Math.round(device.vram_total / 1024 / 1024 / 1024);
        const info = `${gpuName} • ${vramFreeGB}/${vramTotalGB} GB free${nodeCountStr} • via ${mode}`;
        setHealthResults(prev => ({ ...prev, [env.id]: { status: 'ok', info, time: Date.now(), nodeCount: nodes.length } }));
      } else {
        const info = `Connected (no GPU info)${nodeCountStr} • via ${mode}`;
        setHealthResults(prev => ({ ...prev, [env.id]: { status: 'ok', info, time: Date.now(), nodeCount: nodes.length } }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection failed';
      setHealthResults(prev => ({ ...prev, [env.id]: { status: 'error', info: msg, time: Date.now() } }));
    } finally {
      setCheckingEnv(null);
    }
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between pl-1">
        <h5 className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest flex items-center gap-1.5">
          <Link size={11} /> Environments
        </h5>
        <button
          onClick={addEnv}
          className="flex items-center gap-1 text-[9px] font-bold text-emerald-500 hover:text-emerald-400 transition-colors uppercase tracking-wider"
        >
          <Plus size={10} /> Add
        </button>
      </div>

      <div className="flex flex-col gap-3 overflow-y-auto pr-1">
        {environments.map(env => {
          const isActive = config.activeEnvironmentId === env.id;
          const health = healthResults[env.id];
          const isChecking = checkingEnv === env.id;

          return (
            <div
              key={env.id}
              className={`flex flex-col gap-2.5 rounded-xl p-3 border transition-all ${
                isActive
                  ? 'bg-[var(--bg-stage)] border-emerald-500/50'
                  : 'bg-[var(--bg-stage)] border-[var(--border-subtle)]'
              }`}
            >
              {/* Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-1">
                  <button
                    onClick={() => setConfig({ activeEnvironmentId: env.id })}
                    className={`p-1 rounded-full transition-colors ${isActive ? 'text-emerald-500' : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'}`}
                    title={isActive ? 'Active Environment' : 'Set as Active'}
                  >
                    <CheckCircle2 size={14} className={isActive ? 'opacity-100' : 'opacity-50'} />
                  </button>
                  <input
                    type="text"
                    value={env.name}
                    onChange={(e) => updateEnv(env.id, { name: e.target.value })}
                    className="bg-transparent border-none text-[11px] font-bold text-[var(--text-main)] focus:outline-none w-32 focus:ring-1 focus:ring-emerald-500/50 rounded px-1 -ml-1"
                  />
                </div>
                {environments.length > 1 && (
                  <button
                    onClick={() => removeEnv(env.id)}
                    className="text-[var(--text-muted)] hover:text-rose-500 transition-colors p-1"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>

              {/* URL Input */}
              <div className="flex flex-col gap-1">
                <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-wider pl-0.5 flex items-center gap-1">
                  <Link size={9} /> ComfyUI URL
                </span>
                <input
                  type="text"
                  value={env.url}
                  onChange={(e) => updateEnv(env.id, { url: e.target.value })}
                  placeholder="http://localhost:8188"
                  className="w-full bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-lg px-2 py-1.5 text-[10px] text-[var(--text-main)] focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all font-mono"
                />
              </div>

              {/* Connection Mode */}
              <div className="flex items-center justify-between">
                <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-wider pl-0.5">
                  Mode
                </span>
                <ActionDropdown
                  options={[
                    { value: 'auto', label: 'Auto', description: 'Recommended' },
                    { value: 'direct', label: 'Direct', description: 'Browser → ComfyUI' },
                    { value: 'proxy', label: 'Proxy', description: 'Browser → Server → ComfyUI' },
                  ]}
                  onSelect={(val) => updateEnv(env.id, { connectionMode: val as ConnectionMode })}
                  align="right"
                  trigger={() => (
                    <FancyButton variant="zinc" subtle={true} size="xs" className="px-2 gap-1 h-6">
                      <span className="truncate">{env.connectionMode === 'direct' ? 'Direct' : env.connectionMode === 'proxy' ? 'Proxy' : 'Auto'}</span>
                      <ChevronDown size={8} className="opacity-50 shrink-0" />
                    </FancyButton>
                  )}
                />
              </div>

              {/* Health Check */}
              <div className="flex items-center justify-between">
                <button
                  onClick={() => checkHealth(env)}
                  disabled={isChecking}
                  className="flex items-center gap-1 text-[9px] font-bold text-[var(--text-muted)] hover:text-emerald-500 transition-colors uppercase tracking-wider disabled:opacity-50"
                >
                  <Wifi size={9} className={isChecking ? 'animate-pulse' : ''} />
                  {isChecking ? 'Checking...' : 'Check Health'}
                </button>
                {health && (
                  <span className={`text-[9px] font-bold ${health.status === 'ok' ? 'text-emerald-500' : 'text-rose-500'}`}>
                    {health.status === 'ok' ? '✓' : '✗'} {health.info}
                  </span>
                )}
              </div>

              {/* Installed Nodes (collapsible) */}
              {installedNodes[env.id]?.length > 0 && (
                <div className="flex flex-col">
                  <button
                    onClick={() => setExpandedNodes(prev => ({ ...prev, [env.id]: !prev[env.id] }))}
                    className="flex items-center gap-1 text-[9px] font-bold text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors uppercase tracking-wider"
                  >
                    {expandedNodes[env.id] ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
                    Installed Nodes ({installedNodes[env.id].length})
                  </button>
                  {expandedNodes[env.id] && (
                    <div className="mt-1.5 flex flex-col gap-1.5 rounded-lg bg-[var(--bg-panel)] border border-[var(--border-subtle)] p-2">
                      <input
                        type="text"
                        value={nodeSearch[env.id] || ''}
                        onChange={(e) => setNodeSearch(prev => ({ ...prev, [env.id]: e.target.value }))}
                        placeholder="Search nodes..."
                        className="w-full bg-[var(--bg-stage)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[9px] text-[var(--text-main)] focus:outline-none focus:border-emerald-500/50 font-mono"
                      />
                      <div className="max-h-36 overflow-y-auto">
                        <div className="flex flex-wrap gap-1">
                          {installedNodes[env.id]
                            .filter(node => !nodeSearch[env.id] || node.toLowerCase().includes(nodeSearch[env.id].toLowerCase()))
                            .map(node => (
                              <span
                                key={node}
                                className="text-[9px] font-mono text-[var(--text-muted)] bg-[var(--bg-stage)] px-1.5 py-0.5 rounded"
                              >
                                {node}
                              </span>
                            ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Connection Guide */}
      <div className="mt-2 px-2 py-2.5 rounded-lg bg-[var(--bg-panel)] border border-[var(--border-subtle)]">
        <p className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-wider mb-1.5">
          🔌 Connection Guide
        </p>
        <div className="text-[9px] text-[var(--text-muted)] leading-relaxed space-y-1.5">
          <p><strong className="text-[var(--text-main)]">Same machine (localhost):</strong> Works directly. Start ComfyUI with <code className="bg-[var(--bg-stage)] px-1 rounded text-[8px]">--enable-cors-header</code></p>
          <p><strong className="text-[var(--text-main)]">LAN machine (192.168.x.x):</strong> If using HTTPS cloud, browser blocks mixed content. Solutions:</p>
          <ul className="list-disc pl-3 space-y-0.5">
            <li>SSH tunnel: <code className="bg-[var(--bg-stage)] px-1 rounded text-[8px]">ssh -L 8188:comfy-host:8188 user@comfy-host</code> → connect to localhost:8188</li>
            <li>Cloudflare Tunnel / ngrok → gives ComfyUI an HTTPS URL</li>
            <li>Reverse proxy with HTTPS (Caddy/nginx) on ComfyUI machine</li>
          </ul>
          <p><strong className="text-[var(--text-main)]">WebSocket:</strong> Always connects directly (not affected by CORS/mixed-content)</p>
        </div>
      </div>
    </div>
  );
}
