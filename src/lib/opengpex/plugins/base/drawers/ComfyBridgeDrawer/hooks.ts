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

import { useMemo, useState, useCallback, useEffect, useSyncExternalStore } from 'react';
import { usePluginSelfConfig, usePluginCommands } from '@opengpex/editor/core/context';
import { useEditorState } from '@opengpex/editor/core/context';
import { ComfyBridgeConfig, ComfyEnvironment, ConnectionStatus, ExecutionRecord, INITIAL_EXECUTION_STATE, DEFAULT_COMFY_CONFIG } from './protocols';
import type { ExposedParam, NumberConfig, PromptConfig, TextConfig, ComboConfig } from './protocols';
import { subscribeExecState, getExecStateSnapshot, cancelExecution } from './commands';
import type { ComfyBridgeDrawerCommandsMap } from './commands.d';
import { ComfyClient } from './api/client';

/**
 * useComfyBridgeState: Semantic state hook for ComfyBridge drawer.
 *
 * Manages:
 * - Plugin config read/write
 * - Connection status (transient)
 * - Execution state (phase + progress, bridged from commands.ts module-level store)
 * - Active environment derivation
 * - Active workflow derivation
 *
 * Note: WebSocket connection is NOT maintained here. It is created on-demand
 * inside commands.ts when a workflow is actually executed. This avoids spurious
 * connections while the user edits settings.
 */
export function useComfyBridgeState() {
  const [config, setSelfConfig] = usePluginSelfConfig<ComfyBridgeConfig>();
  const { runWorkflowCmd, testConnectionCmd, openSettingsCmd } = usePluginCommands<ComfyBridgeDrawerCommandsMap>();
  const { activeLayer, activeFrame } = useEditorState();

  // Transient states (not persisted)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [isTesting, setIsTesting] = useState(false);

  // Subscribe to execution state from commands.ts module-level bridge
  const execState = useSyncExternalStore(
    subscribeExecState,
    getExecStateSnapshot,
    () => INITIAL_EXECUTION_STATE, // Server snapshot
  );

  // Derive active environment
  const environments = config.environments?.length ? config.environments : DEFAULT_COMFY_CONFIG.environments;
  const activeEnv: ComfyEnvironment | undefined =
    environments.find(e => e.id === config.activeEnvironmentId) || environments[0];

  // Derive active workflow
  const workflows = useMemo(() => config.workflows || [], [config.workflows]);

  // Auto-select workflow logic:
  // 1. If activeWorkflowId points to an existing workflow → keep it (last selected)
  // 2. If only 1 workflow exists → auto-select it
  // 3. If multiple workflows exist but no valid selection → select the first one
  const resolvedActiveWorkflowId = useMemo(() => {
    if (workflows.length === 0) return null;
    const currentId = config.activeWorkflowId;
    // Check if current selection is still valid
    if (currentId && workflows.some(w => w.id === currentId)) {
      return currentId;
    }
    // Fall back to first workflow
    return workflows[0].id;
  }, [workflows, config.activeWorkflowId]);

  // Sync resolved ID back to config if it differs (e.g. after adding first workflow)
  // Use useEffect to avoid calling setSelfConfig during render
  useEffect(() => {
    if (resolvedActiveWorkflowId !== null && resolvedActiveWorkflowId !== config.activeWorkflowId) {
      setSelfConfig({ activeWorkflowId: resolvedActiveWorkflowId });
    }
  }, [resolvedActiveWorkflowId, config.activeWorkflowId, setSelfConfig]);

  const activeWorkflow = workflows.find(w => w.id === resolvedActiveWorkflowId) || null;

  // ─── Sync Object Info Handler ──────────────────────────────────────────────

  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  /** Sync exposed param types/configs from ComfyUI /object_info for the active workflow */
  const handleSyncObjectInfo = useCallback(async (): Promise<void> => {
    if (!activeWorkflow) return;

    const envs = config.environments || [];
    const env: ComfyEnvironment | undefined = envs.find(e => e.id === config.activeEnvironmentId) || envs[0];
    if (!env?.url) {
      setSyncError('No ComfyUI environment configured');
      return;
    }

    setIsSyncing(true);
    setSyncError(null);

    try {
      const client = new ComfyClient(env.url, env.connectionMode || 'auto');
      type ObjectInfoInputDef = [string | string[], Record<string, unknown>?];
      interface ObjectInfoNode { input?: { required?: Record<string, ObjectInfoInputDef>; optional?: Record<string, ObjectInfoInputDef> } }
      const objectInfo = await client.getObjectInfo() as Record<string, ObjectInfoNode>;

      const updatedParams: ExposedParam[] = activeWorkflow.exposedParams.map(param => {
        const nodeInfo = objectInfo[param.nodeClass];
        if (!nodeInfo?.input) return param;

        const inputDef: ObjectInfoInputDef | undefined =
          nodeInfo.input.required?.[param.paramName] ||
          nodeInfo.input.optional?.[param.paramName];

        if (!inputDef) return param;

        const [typeDef, opts] = inputDef;
        const options = opts || {};

        if (Array.isArray(typeDef)) {
          const comboOptions = typeDef.filter((v): v is string => typeof v === 'string');
          return { ...param, type: 'combo' as const, config: { default: param.paramValue, options: comboOptions } satisfies ComboConfig };
        }

        const typeStr = typeDef as string;

        if (typeStr === 'FLOAT') {
          const min = typeof options.min === 'number' ? options.min : undefined;
          const max = typeof options.max === 'number' ? options.max : undefined;
          const step = typeof options.step === 'number' ? options.step : undefined;
          const decimals = step != null && step > 0
            ? Math.max(0, -Math.floor(Math.log10(step)))
            : (param.type === 'number' ? (param.config as NumberConfig).decimals : 2);
          const defaultVal = typeof options.default === 'number' ? options.default : parseFloat(param.paramValue);
          return { ...param, type: 'number' as const, config: { default: isNaN(defaultVal) ? 0 : defaultVal, decimals, min, max, step } satisfies NumberConfig };
        }

        if (typeStr === 'INT') {
          const min = typeof options.min === 'number' ? options.min : undefined;
          const max = typeof options.max === 'number' ? options.max : undefined;
          const defaultVal = typeof options.default === 'number' ? options.default : parseInt(param.paramValue, 10);
          return { ...param, type: 'number' as const, config: { default: isNaN(defaultVal) ? 0 : defaultVal, decimals: 0, min, max } satisfies NumberConfig };
        }

        if (typeStr === 'STRING') {
          const multiline = options.multiline === true;
          const nameLower = param.paramName.toLowerCase();
          const titleLower = param.nodeTitle.toLowerCase();
          const isPrompt = nameLower.includes('prompt') || titleLower.includes('prompt');
          if (isPrompt) {
            const isNegative = nameLower.includes('negative') || titleLower.includes('negative');
            const sentiment: PromptConfig['sentiment'] = isNegative ? 'negative' : 'positive';
            return { ...param, type: 'prompt' as const, config: { default: param.paramValue, placeholder: isNegative ? 'Negative prompt...' : 'Describe what you want...', sentiment } satisfies PromptConfig };
          }
          return { ...param, type: 'text' as const, config: { default: param.paramValue, multiline } satisfies TextConfig };
        }

        return param;
      });

      const updatedWorkflows = (config.workflows || []).map(wf =>
        wf.id === activeWorkflow.id ? { ...wf, exposedParams: updatedParams } : wf
      );
      setSelfConfig({ workflows: updatedWorkflows });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSyncError(msg);
    } finally {
      setIsSyncing(false);
    }
  }, [activeWorkflow, config, setSelfConfig]);

  // ─── Test Connection Handler ───────────────────────────────────────────────

  // Test connection handler — returns success boolean for callers that need it.
  // Only sets 'checking' if not already unhealthy (to avoid banner flash).
  const handleTestConnection = useCallback(async (): Promise<boolean> => {
    setIsTesting(true);
    if (connectionStatus !== 'unhealthy') {
      setConnectionStatus('checking');
    }
    try {
      const result = await testConnectionCmd?.execute() as { success: boolean } | undefined;
      const success = result?.success ?? false;
      setConnectionStatus(success ? 'healthy' : 'unhealthy');
      return success;
    } catch {
      setConnectionStatus('unhealthy');
      return false;
    } finally {
      setIsTesting(false);
    }
  }, [testConnectionCmd, connectionStatus]);

  // Detect if the current frame was generated by ComfyUI
  const isComfyGenerated = Boolean(activeFrame?.extra?.ai_generation && activeFrame?.extra?.ai_provider === 'ComfyUI');

  // ─── History Actions ───────────────────────────────────────────────────────

  /** Reuse params from a history record: switch to that workflow + populate param values */
  const reuseParams = useCallback((record: ExecutionRecord) => {
    const targetWorkflow = workflows.find(w => w.id === record.workflowId);
    if (!targetWorkflow) return; // Workflow was deleted since that run

    setSelfConfig({
      activeWorkflowId: record.workflowId,
      workflowParamValues: { ...record.params },
    });
  }, [workflows, setSelfConfig]);

  /** Export full execution history as a JSON file download */
  const exportHistory = useCallback(() => {
    const history = config.executionHistory || [];
    const exportData = {
      exportedAt: new Date().toISOString(),
      totalRecords: history.length,
      records: history,
    };

    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `comfyui_history_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [config.executionHistory]);

  /** Clear all execution history */
  const clearHistory = useCallback(() => {
    setSelfConfig({ executionHistory: [] });
  }, [setSelfConfig]);

  /** Delete a single execution record by id */
  const deleteRecord = useCallback((id: string) => {
    const history = config.executionHistory || [];
    setSelfConfig({ executionHistory: history.filter(r => r.id !== id) });
  }, [config.executionHistory, setSelfConfig]);

  return useMemo(() => {
    const hasActiveLayer = Boolean(activeLayer);
    const frameExists = Boolean(activeFrame);
    const inputSource = config.inputSource || 'active-layer';
    // Can run if: workflow selected + not unhealthy
    // + img2img requires a frame to exist
    // + img2img with active-layer source also requires an active layer
    const needsFrame = activeWorkflow?.mode === 'img2img';
    const needsLayer = needsFrame && inputSource === 'active-layer';
    const canRun = Boolean(activeWorkflow)
      && connectionStatus !== 'unhealthy'
      && (!needsFrame || frameExists)
      && (!needsLayer || hasActiveLayer);

    // Execution history (newest first, capped at 20 for display)
    const executionHistory = (config.executionHistory || []).slice(0, 20);
    const totalHistoryCount = (config.executionHistory || []).length;

    return {
      // Config
      config,
      environments,
      activeEnv,

      // Workflow
      workflows,
      activeWorkflow,

      // Derived states
      frameExists,
      hasActiveLayer,
      canRun,
      connectionStatus,
      isTesting,

      // Execution state (phase-aware progress)
      execState,

      // Frame origin info
      isComfyGenerated,

      // Execution history
      executionHistory,
      totalHistoryCount,

      // Actions
      updateConfig: setSelfConfig,
      setActiveEnvironment: (envId: string) => setSelfConfig({ activeEnvironmentId: envId }),
      setActiveWorkflow: (wfId: string | null) => setSelfConfig({ activeWorkflowId: wfId }),
      testConnection: handleTestConnection,
      syncObjectInfo: handleSyncObjectInfo,
      isSyncing,
      syncError,
      cancelExecution,
      reuseParams,
      exportHistory,
      clearHistory,
      deleteRecord,

      // Commands
      runWorkflowCmd,
      testConnectionCmd,
      openSettingsCmd,
    };
  }, [config, setSelfConfig, activeLayer, activeFrame, connectionStatus, isTesting, isSyncing, syncError, execState, environments, activeEnv, workflows, activeWorkflow, isComfyGenerated, runWorkflowCmd, testConnectionCmd, openSettingsCmd, handleTestConnection, handleSyncObjectInfo, reuseParams, exportHistory, clearHistory, deleteRecord]);
}
