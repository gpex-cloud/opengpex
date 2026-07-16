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

import React, { useState, useCallback, useRef, useMemo } from 'react';
import { usePluginSelfConfig } from '@opengpex/editor/core/context';
import {
  Plus, Trash2, CheckCircle2, Link, Wifi, AlertCircle,
  Upload, Clipboard, FileJson, ChevronDown, ChevronRight,
  Pencil, Image as ImageIcon, Type, Download, Loader2,
} from 'lucide-react';
import FancyButton from '@opengpex/editor/widgets/FancyButton';
import ActionDropdown from '@opengpex/editor/widgets/ActionDropdown';
import { ComfyBridgeConfig, ComfyEnvironment, UserWorkflow, ConnectionMode } from './protocols';
import { ComfyClient } from './api/client';
import { parseWorkflowJson, createUserWorkflow, summarizeHistoryEntry, deduplicateHistoryWorkflows, generateWorkflowName } from './api/workflow-parser';
import type { ParseResult, HistoryWorkflowSummary } from './api/workflow-parser';

// ─── Main Settings Component ───────────────────────────────────────────────────

export function ComfyBridgeSettings() {
  const [config, setConfig] = usePluginSelfConfig<ComfyBridgeConfig>();
  const [healthResults, setHealthResults] = useState<Record<string, { status: 'ok' | 'error'; info?: string; time?: number; nodeCount?: number }>>({});
  const [installedNodes, setInstalledNodes] = useState<Record<string, string[]>>({});
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [nodeSearch, setNodeSearch] = useState<Record<string, string>>({});
  const [checkingEnv, setCheckingEnv] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<'idle' | 'paste' | 'configure'>('idle');
  const [importJson, setImportJson] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [parsedTemplate, setParsedTemplate] = useState<Record<string, unknown> | null>(null);
  const [workflowName, setWorkflowName] = useState('');
  const [workflowDesc, setWorkflowDesc] = useState('');
  const [selectedParams, setSelectedParams] = useState<Set<string>>(new Set());
  const [workflowsExpanded, _setWorkflowsExpanded] = useState(true);
  /** When editing an existing workflow, holds its ID (null = creating new) */
  const [editingWorkflowId, setEditingWorkflowId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const environments = useMemo(() => config.environments || [], [config.environments]);
  const workflows = useMemo(() => config.workflows || [], [config.workflows]);

  // ─── Environment Management ────────────────────────────────────────────────

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

      // Fetch system stats and installed nodes in parallel
      const [stats, nodes] = await Promise.all([
        client.getSystemStats(),
        client.getInstalledNodes().catch(() => [] as string[]),
      ]);

      // Store installed nodes for this environment
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

  // ─── Workflow Import ───────────────────────────────────────────────────────

  const processJsonImport = useCallback((text: string, defaultName?: string) => {
    setImportError(null);
    try {
      const json = JSON.parse(text);
      const result = parseWorkflowJson(json);

      if (!result.valid) {
        setImportError(result.error || 'Invalid workflow JSON');
        return;
      }

      setParseResult(result);
      setParsedTemplate(json as Record<string, unknown>);
      setWorkflowName(defaultName || '');
      setWorkflowDesc('');
      setSelectedParams(new Set());
      setEditingWorkflowId(null);
      setImportMode('configure');
    } catch {
      setImportError('Invalid JSON format. Could not parse.');
    }
  }, []);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Use filename (without extension) as default workflow name
    const defaultName = file.name.replace(/\.json$/i, '').trim();

    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      processJsonImport(text, defaultName);
    };
    reader.readAsText(file);
    // Reset input so same file can be re-selected
    e.target.value = '';
  }, [processJsonImport]);

  const handlePasteImport = useCallback(() => {
    processJsonImport(importJson);
  }, [importJson, processJsonImport]);

  // ─── Workflow Edit ─────────────────────────────────────────────────────────

  const handleEditWorkflow = useCallback((workflow: UserWorkflow) => {
    // Re-parse the template to get candidate params
    const result = parseWorkflowJson(workflow.template);
    if (!result.valid) return;

    setParseResult(result);
    setParsedTemplate(workflow.template);
    setWorkflowName(workflow.name);
    setWorkflowDesc(workflow.description);
    // Pre-select previously exposed params
    setSelectedParams(new Set(workflow.exposedParams.map(p => p.path)));
    setEditingWorkflowId(workflow.id);
    setImportMode('configure');
  }, []);

  // ─── Workflow Save (create or update) ──────────────────────────────────────

  const resetImportState = useCallback(() => {
    setImportMode('idle');
    setImportJson('');
    setParseResult(null);
    setParsedTemplate(null);
    setWorkflowName('');
    setWorkflowDesc('');
    setSelectedParams(new Set());
    setEditingWorkflowId(null);
    setImportError(null);
  }, []);

  const handleSaveWorkflow = useCallback(() => {
    if (!parseResult || !parsedTemplate) return;
    if (!workflowName.trim()) return;

    const newWorkflow = createUserWorkflow(
      workflowName.trim(),
      workflowDesc.trim(),
      parsedTemplate,
      parseResult,
      Array.from(selectedParams),
    );

    if (editingWorkflowId) {
      // Update existing workflow (preserve original id and createdAt)
      const existing = workflows.find(w => w.id === editingWorkflowId);
      const updatedWorkflow = {
        ...newWorkflow,
        id: editingWorkflowId,
        createdAt: existing?.createdAt || newWorkflow.createdAt,
      };
      setConfig({ workflows: workflows.map(w => w.id === editingWorkflowId ? updatedWorkflow : w) });
    } else {
      // Create new workflow
      setConfig({ workflows: [...workflows, newWorkflow] });
    }

    // Reset import state
    resetImportState();
  }, [parseResult, parsedTemplate, workflowName, workflowDesc, selectedParams, workflows, setConfig, editingWorkflowId, resetImportState]);

  const removeWorkflow = useCallback((id: string) => {
    setConfig({ workflows: workflows.filter(w => w.id !== id) });
  }, [workflows, setConfig]);

  const toggleParam = useCallback((path: string) => {
    setSelectedParams(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // ─── Import from Server ────────────────────────────────────────────────────
  const [serverImportState, setServerImportState] = useState<'idle' | 'fetching' | 'selecting'>('idle');
  /** Grouped workflows: envId → deduplicated summaries */
  const [serverWorkflowGroups, setServerWorkflowGroups] = useState<{ envId: string; envName: string; workflows: HistoryWorkflowSummary[]; error?: string }[]>([]);
  const [serverImportError, setServerImportError] = useState<string | null>(null);
  const [serverSelectedId, setServerSelectedId] = useState<string | null>(null);

  const handleImportFromServer = useCallback(async () => {
    if (environments.length === 0) {
      setServerImportError('No environment configured');
      return;
    }

    setServerImportState('fetching');
    setServerImportError(null);
    setServerWorkflowGroups([]);

    // Fetch from all environments in parallel
    const results = await Promise.allSettled(
      environments.map(async (env) => {
        const client = new ComfyClient(env.url, env.connectionMode);
        const history = await client.getAllHistory();
        return { env, history };
      })
    );

    const groups: typeof serverWorkflowGroups = [];
    let totalWorkflows = 0;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const env = environments[i];

      if (result.status === 'rejected') {
        groups.push({ envId: env.id, envName: env.name, workflows: [], error: result.reason?.message || 'Connection failed' });
        continue;
      }

      const entries = Object.entries(result.value.history);
      if (entries.length === 0) {
        groups.push({ envId: env.id, envName: env.name, workflows: [], error: 'No execution history' });
        continue;
      }

      // Convert to summaries (reverse order = newest first)
      const summaries: HistoryWorkflowSummary[] = [];
      for (const [promptId, entry] of entries.reverse()) {
        const summary = summarizeHistoryEntry(promptId, entry);
        if (summary) summaries.push(summary);
      }

      const deduplicated = deduplicateHistoryWorkflows(summaries);
      totalWorkflows += deduplicated.length;
      groups.push({ envId: env.id, envName: env.name, workflows: deduplicated });
    }

    if (totalWorkflows === 0) {
      setServerImportError('No workflows found in any server history. Run a workflow in ComfyUI first.');
      setServerImportState('idle');
      return;
    }

    setServerWorkflowGroups(groups);
    setServerImportState('selecting');
  }, [environments]);

  const handleServerImportSelect = useCallback((summary: HistoryWorkflowSummary) => {
    // Feed the workflow into the standard configure flow
    const name = generateWorkflowName(summary);
    processJsonImport(JSON.stringify(summary.workflow), name);
    // Reset server import state
    setServerImportState('idle');
    setServerWorkflowGroups([]);
    setServerSelectedId(null);
  }, [processJsonImport]);

  const cancelServerImport = useCallback(() => {
    setServerImportState('idle');
    setServerWorkflowGroups([]);
    setServerImportError(null);
    setServerSelectedId(null);
  }, []);

  // ─── Tab State ─────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'environments' | 'workflows'>('environments');

  // ─── Render ────────────────────────────────────────────────────────────────

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
      {activeTab === 'environments' && <div className="flex flex-col gap-3">
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

                {/* Installed Nodes (collapsible, shown after successful health check) */}
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
                        {/* Search */}
                        <input
                          type="text"
                          value={nodeSearch[env.id] || ''}
                          onChange={(e) => setNodeSearch(prev => ({ ...prev, [env.id]: e.target.value }))}
                          placeholder="Search nodes..."
                          className="w-full bg-[var(--bg-stage)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[9px] text-[var(--text-main)] focus:outline-none focus:border-emerald-500/50 font-mono"
                        />
                        {/* Node list */}
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

      </div>}

      {/* ═══ Workflows Tab ═══ */}
      {activeTab === 'workflows' && <div className="flex flex-col gap-3">

        {workflowsExpanded && (
          <>
            {/* Existing Workflows List */}
            {workflows.length > 0 && (
              <div className="flex flex-col gap-2">
                {workflows.map(wf => (
                  <WorkflowCard
                    key={wf.id}
                    workflow={wf}
                    onEdit={() => handleEditWorkflow(wf)}
                    onRemove={() => removeWorkflow(wf.id)}
                  />
                ))}
              </div>
            )}

            {workflows.length === 0 && importMode === 'idle' && (
              <p className="text-[9px] text-[var(--text-muted)] italic px-1">
                No custom workflows imported yet. Import a ComfyUI workflow JSON to get started.
              </p>
            )}

            {/* Import Actions */}
            {importMode === 'idle' && serverImportState === 'idle' && (
              <div className="flex flex-wrap gap-2 mt-1">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1 text-[9px] font-bold text-emerald-500 hover:text-emerald-400 transition-colors uppercase tracking-wider"
                >
                  <Upload size={10} /> Import JSON
                </button>
                <button
                  onClick={() => setImportMode('paste')}
                  className="flex items-center gap-1 text-[9px] font-bold text-emerald-500 hover:text-emerald-400 transition-colors uppercase tracking-wider"
                >
                  <Clipboard size={10} /> Paste JSON
                </button>
                <button
                  onClick={handleImportFromServer}
                  className="flex items-center gap-1 text-[9px] font-bold text-emerald-500 hover:text-emerald-400 transition-colors uppercase tracking-wider"
                >
                  <Download size={10} /> From Server
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </div>
            )}

            {/* Server Import: Fetching */}
            {serverImportState === 'fetching' && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
                <Loader2 size={14} className="text-emerald-500 animate-spin" />
                <span className="text-[9px] font-bold text-[var(--text-muted)]">Fetching workflow history from server...</span>
              </div>
            )}

            {/* Server Import: Error */}
            {serverImportError && serverImportState === 'idle' && (
              <div className="flex items-start gap-1.5 p-2 rounded-lg bg-rose-500/5 border border-rose-500/20">
                <AlertCircle size={10} className="text-rose-500 mt-0.5 shrink-0" />
                <span className="text-[8px] font-bold text-rose-500">{serverImportError}</span>
              </div>
            )}

            {/* Server Import: Selection Panel (grouped by server) */}
            {serverImportState === 'selecting' && serverWorkflowGroups.length > 0 && (
              <div className="flex flex-col gap-2 p-3 rounded-xl bg-[var(--bg-stage)] border border-emerald-500/30">
                <div className="flex items-center justify-between">
                  <span className="text-[9px] font-black text-emerald-500 uppercase tracking-widest">
                    Select Workflow
                  </span>
                  <button
                    onClick={cancelServerImport}
                    className="text-[9px] font-bold text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors uppercase tracking-wider"
                  >
                    Cancel
                  </button>
                </div>
                <div className="max-h-56 overflow-y-auto flex flex-col gap-2">
                  {serverWorkflowGroups.map((group) => (
                    <div key={group.envId} className="flex flex-col gap-1">
                      {/* Server divider — always show when multiple environments */}
                      {serverWorkflowGroups.length > 1 && (
                        <div className="flex items-center gap-2 py-1">
                          <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-widest shrink-0">
                            {group.envName}
                          </span>
                          <div className="flex-1 h-px bg-[var(--border-subtle)]" />
                          {group.error && (
                            <span className="text-[8px] text-rose-500 font-bold shrink-0">{group.error}</span>
                          )}
                          {!group.error && group.workflows.length > 0 && (
                            <span className="text-[8px] text-[var(--text-muted)] shrink-0">{group.workflows.length}</span>
                          )}
                        </div>
                      )}
                      {/* Workflow items */}
                      {group.workflows.map((summary: HistoryWorkflowSummary) => {
                        const name = generateWorkflowName(summary);
                        const isSelected = serverSelectedId === summary.promptId;
                        const hasInput = Object.values(summary.workflow as Record<string, { class_type?: string }>).some(
                          n => n.class_type === 'LoadImage' || n.class_type === 'LoadImageMask'
                        );
                        return (
                          <button
                            key={summary.promptId}
                            onClick={() => {
                              setServerSelectedId(summary.promptId);
                              handleServerImportSelect(summary);
                            }}
                            className={`flex flex-col gap-0.5 px-2.5 py-2 rounded-lg border text-left transition-all ${
                              isSelected
                                ? 'bg-emerald-500/10 border-emerald-500/40'
                                : 'bg-[var(--bg-panel)] border-[var(--border-subtle)] hover:border-emerald-500/30'
                            }`}
                          >
                            <span className="text-[11px] font-bold text-[var(--text-main)] truncate">
                              {name}
                            </span>
                            <div className="flex items-center gap-2 text-[9px] text-[var(--text-secondary)] flex-wrap">
                              <span>{summary.nodeCount} nodes</span>
                              <span className={`font-bold ${hasInput ? 'text-emerald-500' : 'text-blue-500'}`}>
                                {hasInput ? 'img2img' : 'txt2img'}
                              </span>
                              {summary.completed && <span className="text-green-500">✓ completed</span>}
                              {summary.createdAt && <span className="opacity-60">created: {summary.createdAt}</span>}
                              {summary.clientId && <span className="opacity-50 font-mono truncate max-w-[80px]" title={summary.clientId}>client: {summary.clientId.slice(0, 8)}</span>}
                            </div>
                          </button>
                        );
                      })}
                      {/* Error for this server (when shown as single env) */}
                      {serverWorkflowGroups.length === 1 && group.error && (
                        <div className="flex items-center gap-1 px-2 py-1">
                          <AlertCircle size={9} className="text-rose-500 shrink-0" />
                          <span className="text-[8px] text-rose-500 font-bold">{group.error}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Paste Mode */}
            {importMode === 'paste' && (
              <div className="flex flex-col gap-2 p-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
                <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-wider">
                  Paste ComfyUI API Format JSON
                </span>
                <textarea
                  value={importJson}
                  onChange={(e) => setImportJson(e.target.value)}
                  placeholder='{"1": {"class_type": "KSampler", "inputs": {...}}, ...}'
                  className="w-full h-24 bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-lg px-2 py-1.5 text-[9px] text-[var(--text-main)] font-mono resize-none focus:outline-none focus:border-emerald-500"
                />
                {importError && (
                  <div className="flex items-start gap-1">
                    <AlertCircle size={9} className="text-rose-500 mt-0.5 shrink-0" />
                    <span className="text-[8px] font-bold text-rose-500">{importError}</span>
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={handlePasteImport}
                    disabled={!importJson.trim()}
                    className="text-[9px] font-bold text-emerald-500 hover:text-emerald-400 transition-colors uppercase tracking-wider disabled:opacity-40"
                  >
                    Parse & Configure
                  </button>
                  <button
                    onClick={resetImportState}
                    className="text-[9px] font-bold text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors uppercase tracking-wider"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Configure Mode (after parsing or when editing) */}
            {importMode === 'configure' && parseResult && (
              <div className="flex flex-col gap-3 p-3 rounded-xl bg-[var(--bg-stage)] border border-emerald-500/30">
                <span className="text-[10px] font-black text-emerald-500 uppercase tracking-widest">
                  {editingWorkflowId ? 'Edit Workflow Configuration' : 'Configure Imported Workflow'}
                </span>

                {/* Detected mode & nodes info */}
                <div className="flex items-center gap-2 text-[9px] text-[var(--text-muted)]">
                  <span>{parseResult.nodeCount} nodes</span>
                  <span>•</span>
                  <span className={`inline-flex items-center gap-0.5 font-bold ${parseResult.inputNodeId ? 'text-emerald-500' : 'text-blue-500'}`}>
                    {parseResult.inputNodeId ? (
                      <><ImageIcon size={9} aria-hidden="true" /> img2img</>
                    ) : (
                      <><Type size={9} /> txt2img</>
                    )}
                  </span>
                  <span>•</span>
                  <span>
                    Input: {parseResult.inputNodeId ? `#${parseResult.inputNodeId} (LoadImage)` : '—'}
                  </span>
                  <span>•</span>
                  <span>
                    Output: {parseResult.outputNodeId ? `#${parseResult.outputNodeId}` : '⚠️ None'}
                  </span>
                </div>

                {/* Name & Description */}
                <div className="flex flex-col gap-2">
                  <input
                    type="text"
                    value={workflowName}
                    onChange={(e) => setWorkflowName(e.target.value)}
                    placeholder="Workflow name (required)"
                    className="w-full bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-lg px-2.5 py-2 text-[11px] text-[var(--text-main)] focus:outline-none focus:border-emerald-500"
                  />
                  <input
                    type="text"
                    value={workflowDesc}
                    onChange={(e) => setWorkflowDesc(e.target.value)}
                    placeholder="Description (optional)"
                    className="w-full bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-lg px-2.5 py-2 text-[11px] text-[var(--text-main)] focus:outline-none focus:border-emerald-500"
                  />
                </div>

                {/* Parameter Selection */}
                {parseResult.candidateParams.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-wider">
                      Expose Parameters ({selectedParams.size}/{parseResult.candidateParams.length})
                    </span>
                    <div className="max-h-40 overflow-y-auto flex flex-col gap-1 pr-1">
                      {parseResult.candidateParams.map(param => (
                        <label
                          key={param.path}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--bg-panel)] cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={selectedParams.has(param.path)}
                            onChange={() => toggleParam(param.path)}
                            className="accent-emerald-500"
                          />
                          <span className="text-[10px] text-[var(--text-main)] flex-1 truncate font-mono">
                            {param.label}
                          </span>
                          <span className="text-[9px] text-[var(--text-muted)] shrink-0">
                            ({param.valueType}: {String(param.currentValue).slice(0, 20)})
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={handleSaveWorkflow}
                    disabled={!workflowName.trim()}
                    className="text-[10px] font-bold text-emerald-500 hover:text-emerald-400 transition-colors uppercase tracking-wider disabled:opacity-40"
                  >
                    ✓ {editingWorkflowId ? 'Update Workflow' : 'Save Workflow'}
                  </button>
                  <button
                    onClick={resetImportState}
                    className="text-[10px] font-bold text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors uppercase tracking-wider"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Import Hints */}
            {importMode === 'idle' && (
              <div className="mt-2 px-1">
                <p className="text-[9px] text-[var(--text-muted)] italic leading-relaxed opacity-60">
                  ℹ️ Export from ComfyUI: use &quot;Save (API Format)&quot; → upload/paste here.
                  System auto-detects LoadImage input and SaveImage/PreviewImage output nodes.
                </p>
              </div>
            )}
          </>
        )}
      </div>}
    </div>
  );
}

// ─── Workflow Card Component ───────────────────────────────────────────────────

function WorkflowCard({ workflow, onEdit, onRemove }: { workflow: UserWorkflow; onEdit: () => void; onRemove: () => void }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-bold text-[var(--text-main)] truncate">
            {workflow.name}
          </span>
          {/* Mode badge */}
          <span className={`text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full border shrink-0 ${
            workflow.mode === 'img2img'
              ? 'text-emerald-600 border-emerald-500/30 bg-emerald-500/10'
              : 'text-blue-600 border-blue-500/30 bg-blue-500/10'
          }`}>
            {workflow.mode}
          </span>
        </div>
        <span className="text-[9px] text-[var(--text-muted)]">
          {workflow.exposedParams.length} params •
          {workflow.inputNodeId ? ' has input' : ' no input'} •
          {workflow.outputNodeId ? ' has output' : ' no output'} •
          {new Date(workflow.createdAt).toLocaleDateString()}
        </span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={onEdit}
          className="text-[var(--text-muted)] hover:text-emerald-500 transition-colors p-1"
          title="Edit workflow configuration"
        >
          <Pencil size={11} />
        </button>
        <button
          onClick={onRemove}
          className="text-[var(--text-muted)] hover:text-rose-500 transition-colors p-1"
          title="Remove workflow"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}
