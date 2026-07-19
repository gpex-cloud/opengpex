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

import React, { useState } from 'react';
import { Settings, ChevronDown, Wifi, WifiOff, FileJson, RotateCcw, Sparkles, Clock, Image as ImageIcon, AlertTriangle, RefreshCw } from 'lucide-react';
import StatusBanner from '@opengpex/editor/widgets/StatusBanner';
import { motion } from 'framer-motion';
import FancyButton from '@opengpex/editor/widgets/FancyButton';
import ActionButton from '@opengpex/editor/widgets/ActionButton';
import ActionDropdown from '@opengpex/editor/widgets/ActionDropdown';
import Tooltip from '@opengpex/editor/widgets/Tooltip';
import { usePluginSelfBusy } from '@opengpex/editor/core/context';
import { ComfyBridgeIcon } from '../icon';
import { useComfyBridgeState } from '../hooks';
import { WorkflowSelector, InputSourceSelector } from './workflower';
import { ExecutionProgressPanel } from './progresser';
import { ComfyBridgeHistory } from './history';

type DrawerTab = 'workflow' | 'history';

/**
 * ComfyBridgeDrawer: ComfyUI Bridge drawer panel
 *
 * Layout:
 * - Header: icon + env name/selector + [Reset] + [Test Connection] + [Settings]
 * - Connection status banner (when unhealthy)
 * - Tab: "workflow" (main content) | "history" (execution records)
 * - Workflow tab: selector, params, progress, Generate+History buttons, input source
 * - History tab: full ComfyBridgeHistory panel + Close History button
 */
export const ComfyBridgeDrawer = React.memo(function ComfyBridgeDrawer() {
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('workflow');

  const {
    config,
    environments,
    activeEnv,
    workflows,
    activeWorkflow,
    frameExists,
    hasActiveLayer,
    canRun,
    connectionStatus,
    isTesting,
    isSyncing,
    syncError,
    execState,
    isComfyGenerated,
    executionHistory,
    totalHistoryCount,
    updateConfig,
    setActiveEnvironment,
    setActiveWorkflow,
    testConnection,
    syncObjectInfo,
    cancelExecution,
    reuseParams,
    exportHistory,
    clearHistory,
    deleteRecord,
    runWorkflowCmd,
    openSettingsCmd,
  } = useComfyBridgeState();

  const isRunning = usePluginSelfBusy();

  const handleRun = async () => {
    // Always pre-flight test connection before running
    const connected = await testConnection();
    if (!connected) return; // Connection failed — UI already updated to unhealthy

    // Connection OK — execute workflow
    try {
      await runWorkflowCmd?.execute();
    } catch (err) {
      console.error('[ComfyBridge] runCmd error:', err);
    }
  };

  // Determine Run button variant based on connection status
  const runVariant = connectionStatus === 'healthy' ? 'green' : 'blue';

  // Param values
  const paramValues = config.workflowParamValues || {};
  const randomSeedPaths = config.randomSeedPaths || [];
  const handleParamChange = (path: string, value: unknown) => {
    updateConfig({ workflowParamValues: { ...paramValues, [path]: value } });
  };
  const handleToggleRandomSeed = (path: string, isRandom: boolean) => {
    if (isRandom) {
      const randomSeed = Math.floor(Math.random() * 2_147_483_647);
      updateConfig({
        randomSeedPaths: [...randomSeedPaths.filter(p => p !== path), path],
        workflowParamValues: { ...paramValues, [path]: randomSeed },
      });
    } else {
      const param = activeWorkflow?.exposedParams.find(p => `${p.nodeId}.${p.paramName}` === path);
      const defaultVal = param?.config?.default ?? 0;
      updateConfig({
        randomSeedPaths: randomSeedPaths.filter(p => p !== path),
        workflowParamValues: { ...paramValues, [path]: defaultVal },
      });
    }
  };

  // Reset params handler (moved from button to header action)
  const handleResetParams = () => {
    if (!activeWorkflow) return;
    const resetValues = { ...paramValues };
    for (const p of activeWorkflow.exposedParams) {
      const pPath = `${p.nodeId}.${p.paramName}`;
      if (randomSeedPaths.includes(pPath)) continue;
      resetValues[pPath] = p.config.default;
    }
    updateConfig({ workflowParamValues: resetValues });
  };

  // Check if history has records
  const hasHistory = totalHistoryCount > 0;

  // Determine if setup is needed:
  // - No server URL configured (env URL is empty or default placeholder)
  // - No workflows imported yet
  const hasServerUrl = Boolean(activeEnv?.url && activeEnv.url.trim() !== '');
  const hasWorkflows = workflows.length > 0;
  // needsSetup is true when either server or workflow is missing (only in workflow tab)
  const needsSetup = drawerTab === 'workflow' && (!hasServerUrl || !hasWorkflows);
  // Distinguish the two setup scenarios for richer messaging
  const needsServer = !hasServerUrl;

  return (
    <div className="flex flex-col gap-2 px-2 pt-1 pb-1 overflow-hidden">
      {/* ─── Header ──────────────────────────────────────────────── */}
      <motion.div layout="position" className="flex justify-between items-center shrink-0">
        <div className="flex items-center gap-2">
          <ComfyBridgeIcon className="text-emerald-600 dark:text-emerald-400" />
          {environments.length <= 1 ? (
            <div className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${
                connectionStatus === 'healthy' ? 'bg-green-500' :
                connectionStatus === 'unhealthy' ? 'bg-red-500' :
                connectionStatus === 'checking' ? 'bg-yellow-500 animate-pulse' :
                'bg-gray-400'
              }`} />
              <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-muted)]">
                {activeEnv?.name || 'ComfyUI'}
              </span>
            </div>
          ) : (
            <ActionDropdown
              options={environments.map(env => ({
                label: env.name,
                value: env.id,
              }))}
              onSelect={setActiveEnvironment}
              trigger={(isOpen) => (
                <div className="flex items-center gap-1 group cursor-pointer">
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    connectionStatus === 'healthy' ? 'bg-green-500' :
                    connectionStatus === 'unhealthy' ? 'bg-red-500' :
                    'bg-gray-400'
                  }`} />
                  <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-main)] group-hover transition-colors">
                    {activeEnv?.name || 'Select Environment'}
                  </span>
                  <ChevronDown
                    size={10}
                    className={`text-[var(--text-muted)] transition-transform duration-200 group-hover ${isOpen ? 'rotate-180' : ''}`}
                  />
                </div>
              )}
            />
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {/* Reset Params (moved from button row to header) */}
          <Tooltip content="Reset Params" position="bottom">
            <button
              onClick={handleResetParams}
              disabled={!activeWorkflow || activeWorkflow.exposedParams.length === 0}
              className="flex items-center justify-center w-6 h-6 rounded-lg text-[var(--text-muted)] hover:bg-[var(--border-subtle)] transition-colors focus:outline-none disabled:opacity-30"
            >
              <RotateCcw size={11} />
            </button>
          </Tooltip>
          {/* Sync Object Info */}
          <Tooltip content="Sync param types from /object_info" position="bottom">
            <button
              onClick={() => syncObjectInfo()}
              disabled={isSyncing || !activeWorkflow}
              className="flex items-center justify-center w-6 h-6 rounded-lg text-[var(--text-muted)] hover:text-emerald-500 hover:bg-emerald-500/10 transition-colors focus:outline-none disabled:opacity-30"
            >
              <RefreshCw size={11} className={isSyncing ? 'animate-spin' : ''} />
            </button>
          </Tooltip>
          {/* Test Connection */}
          <Tooltip content="Test Connection" position="bottom">
            <button
              onClick={() => testConnection()}
              disabled={isTesting}
              className={`flex items-center justify-center w-6 h-6 rounded-lg transition-colors focus:outline-none ${
                connectionStatus === 'healthy'
                  ? 'text-green-500 hover:bg-green-500/10'
                  : connectionStatus === 'unhealthy'
                    ? 'text-red-500 hover:bg-red-500/10'
                    : 'text-[var(--text-muted)] hover:bg-[var(--border-subtle)]'
              } disabled:opacity-50`}
            >
              {connectionStatus === 'unhealthy'
                ? <WifiOff size={12} className={isTesting ? 'animate-pulse' : ''} />
                : <Wifi size={12} className={isTesting ? 'animate-pulse' : ''} />
              }
            </button>
          </Tooltip>
          {/* Settings */}
          <ActionButton
            onClick={() => openSettingsCmd?.execute()}
            icon={<Settings size={12} />}
            tooltip="ComfyUI Settings"
            size="sm"
            variant="glass"
          />
        </div>
      </motion.div>

      {/* ─── Connection Status Banner ────────────────────────────── */}
      {connectionStatus === 'unhealthy' && (
        <StatusBanner
          variant="rose"
          icon={<WifiOff size={16} />}
          title="Cannot connect to ComfyUI"
          description={`Ensure ComfyUI is running at ${activeEnv?.url || 'localhost:8188'}`}
        />
      )}

      {/* ─── History View (replaces main content) ────────────────── */}
      {drawerTab === 'history' && (
        <>
          <ComfyBridgeHistory
            history={executionHistory}
            workflows={workflows}
            onReuseParams={(record) => { reuseParams(record); setDrawerTab('workflow'); }}
            onExportHistory={exportHistory}
            onClearHistory={clearHistory}
            onDeleteRecord={deleteRecord}
          />
          <div className="pt-2">
            <FancyButton
              onClick={() => setDrawerTab('workflow')}
              variant="zinc"
              subtle={true}
              size="xs"
              className="w-full hover:border-emerald-500/50 bg-[var(--bg-stage)] border-[var(--border-subtle)] text-[var(--text-main)] focus:outline-none"
            >
              <Clock size={11} />
              <span className="uppercase font-bold tracking-wider">
                Close History
              </span>
            </FancyButton>
          </div>
        </>
      )}

      {/* ─── Setup Screen (no server URL or no workflows) ────────── */}
      {needsSetup && (
        <div className="flex flex-col items-center justify-center p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-center shrink-0">
          <AlertTriangle size={24} className="text-rose-500 mb-2 opacity-80" />
          <p className="text-[11px] font-bold text-[var(--text-main)] mb-1">
            {needsServer ? 'ComfyUI Server Not Configured' : 'No Workflows Imported'}
          </p>
          <p className="text-[10px] text-[var(--text-muted)] mb-2 px-2 leading-relaxed">
            {needsServer
              ? 'Configure your ComfyUI server URL in Settings to start generating images.'
              : 'Import a ComfyUI workflow JSON in Settings to start generating images.'}
          </p>
          <p className="text-[10px] font-bold text-[var(--text-muted)] mb-4 px-2 leading-relaxed">
            {needsServer
              ? <>🖥️ Start ComfyUI locally with <code className="bg-rose-500/10 px-1 rounded text-[9px]">--enable-cors-header</code>, then add the server URL in Settings.</>
              : <>📂 In ComfyUI, use <strong>&quot;Save (API Format)&quot;</strong> to export a workflow, then import it in Settings.</>
            }
          </p>
          <FancyButton
            onClick={() => openSettingsCmd?.execute()}
            variant="blue"
            size="xs"
            className="w-full focus:outline-none"
          >
            <Settings size={12} className="mr-1" />
            {needsServer ? 'Configure Server' : 'Import Workflow'}
          </FancyButton>
        </div>
      )}

      {/* ─── Workflow Content (main tab) ──────────────────────────── */}
      {drawerTab === 'workflow' && !needsSetup && (
        <>
          {/* ComfyUI-generated Frame Warning */}
          {isComfyGenerated && connectionStatus !== 'unhealthy' && (
            <StatusBanner
              variant="amber"
              icon={<Sparkles size={16} />}
              title="This frame was generated by ComfyUI"
              description="Re-running may produce duplicate results and waste compute resources."
            />
          )}

          {/* Workflow Selector */}
          {workflows.length > 0 ? (
            <WorkflowSelector
              workflows={workflows}
              activeWorkflow={activeWorkflow}
              paramValues={paramValues}
              randomSeedPaths={randomSeedPaths}
              hasFrame={frameExists}
              onSelectWorkflow={setActiveWorkflow}
              onParamChange={handleParamChange}
              onToggleRandomSeed={handleToggleRandomSeed}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 py-4 px-3 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
              <FileJson size={20} className="text-[var(--text-muted)] opacity-50" />
              <p className="text-[9px] text-[var(--text-muted)] text-center leading-relaxed">
                No workflows imported yet.<br />
                Go to <button onClick={() => openSettingsCmd?.execute()} className="text-emerald-500 hover:text-emerald-400 font-bold underline">Settings</button> to import a ComfyUI workflow.
              </p>
            </div>
          )}

          {/* Execution Progress (phase-aware) */}
          {isRunning && execState.phase !== 'idle' && (
            <ExecutionProgressPanel execState={execState} onCancel={cancelExecution} />
          )}

          {/* Generate + History Buttons */}
          <div className="flex items-center gap-1.5 pt-1">
            <FancyButton
              onClick={handleRun}
              disabled={!canRun}
              loading={isRunning}
              variant={runVariant}
              size="xs"
              className="flex-[2] focus:outline-none"
            >
              {!isRunning && (
                <ImageIcon size={12} className="opacity-80" />
              )}
              <span className="uppercase font-bold tracking-wider">
                {isRunning ? 'Processing...' : 'Generate'}
              </span>
            </FancyButton>
            <FancyButton
              onClick={() => setDrawerTab('history')}
              disabled={!hasHistory}
              variant="zinc"
              subtle={true}
              size="xs"
              className="flex-[1] bg-[var(--bg-stage)] border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:border-emerald-500/30 focus:outline-none disabled:opacity-40"
            >
              <Clock size={11} />
              <span className="uppercase font-bold tracking-wider">
                History
              </span>
            </FancyButton>
          </div>

          {/* Input Source Selector (only for img2img workflows) */}
          {activeWorkflow?.mode === 'img2img' && (
            <InputSourceSelector
              inputSource={config.inputSource || 'active-layer'}
              hasActiveLayer={hasActiveLayer}
              disabled={isRunning}
              onChangeSource={(src) => updateConfig({ inputSource: src })}
            />
          )}
        </>
      )}
    </div>
  );
});
