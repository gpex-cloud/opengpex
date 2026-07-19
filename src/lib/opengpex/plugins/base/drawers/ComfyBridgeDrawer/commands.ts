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

/**
 * ComfyBridgeDrawer Commands
 *
 * CMD_RUN: Execute imported custom workflow — upload image (if img2img) → inject params → submit prompt → wait → download result → add as new frame.
 * CMD_TEST_CONNECTION: Tests ComfyUI connectivity via /system_stats.
 */

import { EditorContextValue, EditorCommand } from '@opengpex/editor/core/types';
import { SettingsPanelAPI } from '../../panels/SettingsPanel/protocols';
import { ComfyBridgeConfig, ExecutionRecord } from './protocols';
import { ComfyClient } from './api/client';
import { injectWorkflowParams } from './api/workflow-parser';
import * as P from './protocols';

// ─── Module-level client instance (reused across executions) ───────────────────

import type { ConnectionMode, ExecutionState, ExecutionPhase } from './protocols';
import { INITIAL_EXECUTION_STATE } from './protocols';

let clientInstance: ComfyClient | null = null;
let clientMode: ConnectionMode | null = null;
let _cancelled = false;

function getClient(url: string, connectionMode: ConnectionMode = 'auto'): ComfyClient {
  if (!clientInstance || clientInstance.url !== url || clientMode !== connectionMode) {
    clientInstance?.disconnectWs();
    clientInstance = new ComfyClient(url, connectionMode);
    clientMode = connectionMode;
  }
  return clientInstance;
}

// ─── Module-level Execution State Bridge ───────────────────────────────────────
// Allows commands to push execution state updates to the UI (hooks.ts subscribes).

type ExecutionStateListener = (state: ExecutionState) => void;

let _execState: ExecutionState = { ...INITIAL_EXECUTION_STATE };
const _execListeners = new Set<ExecutionStateListener>();

function setExecState(patch: Partial<ExecutionState>) {
  _execState = { ..._execState, ...patch };
  _execListeners.forEach(fn => fn(_execState));
}

function setExecPhase(phase: ExecutionPhase) {
  setExecState({ phase });
}

function resetExecState() {
  _execState = { ...INITIAL_EXECUTION_STATE };
  _execListeners.forEach(fn => fn(_execState));
}

/** Subscribe to execution state changes. Returns unsubscribe function. */
export function subscribeExecState(fn: ExecutionStateListener): () => void {
  _execListeners.add(fn);
  return () => { _execListeners.delete(fn); };
}

/** Get current execution state snapshot (for initial sync) */
export function getExecStateSnapshot(): ExecutionState {
  return _execState;
}

/** Cancel the currently running/queued execution */
export async function cancelExecution(): Promise<void> {
  const { promptId, phase } = _execState;
  if (!clientInstance || !promptId) return;

  _cancelled = true;

  try {
    if (phase === 'queued') {
      // Still in queue — delete from queue
      await clientInstance.cancelQueued(promptId);
    } else {
      // Already executing — interrupt
      await clientInstance.interrupt();
    }
  } catch (e) {
    console.warn('[ComfyBridge] Cancel failed:', e);
  }
  // The error/complete listener in waitForCompletion will handle cleanup
}

// ─── Helper: Get input image as Blob based on inputSource config ───────────────

import type { InputSource } from './protocols';

async function getInputImageBlob(ctx: EditorContextValue, inputSource: InputSource): Promise<Blob | null> {
  if (inputSource === 'merged-frame') {
    // Composite all visible layers of the active frame (non-destructive)
    const { activeFrame, pixels } = ctx;
    if (!activeFrame) return null;
    const result = await pixels.render.frameToBlob(activeFrame, { format: 'image/png' });
    // frameToBlob returns Blob | ImageBitmap; for 'image/png' format it's always a Blob
    return result as Blob;
  }

  // Default: active-layer — fetch the single selected layer's raw asset
  const { activeLayer, assets } = ctx;
  if (!activeLayer) return null;
  const url = assets.getURL(activeLayer.assetId);
  if (!url) return null;
  const res = await fetch(url);
  return res.blob();
}

// ─── Helper: Append execution record to history ────────────────────────────────

function appendExecutionRecord(ctx: EditorContextValue, record: ExecutionRecord): void {
  const { setSelfConfig, selfConfig } = ctx.scoped || {};
  if (!setSelfConfig) return;

  const config = selfConfig as ComfyBridgeConfig;
  const history = config.executionHistory || [];

  // Prepend new record (newest first)
  const nextHistory = [record, ...history];
  setSelfConfig({ executionHistory: nextHistory });
}

// ─── Command Definitions ───────────────────────────────────────────────────────

export const COMFY_BRIDGE_COMMANDS = {
  run: {
    id: P.CMD_RUN,
    name: 'Run ComfyUI Workflow',
    execute: async (ctx: EditorContextValue) => {
      const { actions } = ctx;
      const { selfConfig } = ctx.scoped || {};
      const config = selfConfig as ComfyBridgeConfig;

      // Must have an active workflow selected
      const activeWfId = config?.activeWorkflowId || null;
      const customWorkflow = activeWfId
        ? (config.workflows || []).find(w => w.id === activeWfId)
        : null;

      if (!customWorkflow) {
        actions.setInteraction({ hud: { message: 'Please select a workflow first', type: 'info' } });
        return { success: false };
      }

      // Find active environment
      const envs = config.environments || [];
      const activeEnv = envs.find(e => e.id === config.activeEnvironmentId) || envs[0];
      if (!activeEnv?.url) {
        actions.setInteraction({ hud: { message: 'No ComfyUI environment configured', type: 'error' } });
        return { success: false };
      }

      const client = getClient(activeEnv.url, activeEnv.connectionMode || 'auto');
      const startTime = Date.now();

      // Reset cancelled flag for this new execution
      _cancelled = false;

      // Mark busy + set initial execution phase
      ctx.scoped!.setBusy(true);
      setExecState({ phase: 'uploading', startedAt: startTime, progress: null, promptId: null });

      // Subscribe to progress events from WebSocket
      const unsubProgress = client.onProgress((p) => {
        setExecState({ phase: 'inferring', progress: p });
      });

      try {
        // Connect WebSocket for progress monitoring
        client.connectWs();

        // Upload input image if the workflow is img2img (has a LoadImage node)
        let comfyFilename: string | undefined;
        if (customWorkflow.inputNodeId && customWorkflow.mode === 'img2img') {
          const inputSource = config.inputSource || 'active-layer';
          const imageBlob = await getInputImageBlob(ctx, inputSource);
          if (imageBlob) {
            const uploadName = `opengpex_input_${Date.now()}.png`;
            comfyFilename = await client.uploadImage(imageBlob, uploadName);
          } else {
            const errMsg = inputSource === 'merged-frame'
              ? 'No active frame available.'
              : 'No active image layer. Select a layer first.';
            actions.setInteraction({ hud: { message: errMsg, type: 'error' } });
            ctx.scoped!.setBusy(false);
            resetExecState();
            return { success: false };
          }
        }

        // Inject exposed param values + input image into workflow template
        setExecPhase('queued');
        const paramValues = config.workflowParamValues || {};

        // Generate random seeds for paths marked as random
        const randomSeedPaths = config.randomSeedPaths || [];
        const effectiveParamValues = { ...paramValues };
        for (const seedPath of randomSeedPaths) {
          // ComfyUI seeds are typically 64-bit integers; use safe range
          effectiveParamValues[seedPath] = Math.floor(Math.random() * 2_147_483_647);
        }

        const workflow = injectWorkflowParams(
          customWorkflow.template,
          effectiveParamValues,
          comfyFilename,
          customWorkflow.inputNodeId,
        );

        // Extract prompt / negative_prompt / seed from exposed params early
        // (needed for history recording at any exit point)
        let positivePrompt: string | undefined;
        let negativePrompt: string | undefined;
        let seed: number | undefined;

        for (const ep of customWorkflow.exposedParams) {
          const epPath = `${ep.nodeId}.${ep.paramName}`;
          const val = effectiveParamValues[epPath];
          if (ep.type === 'prompt') {
            const sentiment = (ep.config as { sentiment?: string }).sentiment;
            if (sentiment === 'negative') {
              negativePrompt = (val as string) ?? (ep.config as { default?: string }).default;
            } else {
              positivePrompt = (val as string) ?? (ep.config as { default?: string }).default;
            }
          } else if (ep.type === 'number') {
            const inputName = ep.paramName.toLowerCase();
            if (inputName === 'seed' || inputName.includes('seed')) {
              seed = (val as number) ?? (ep.config as { default?: number }).default;
            }
          }
        }

        // Submit prompt to ComfyUI queue
        const promptId = await client.submitPrompt(workflow);
        setExecState({ phase: 'loading-model', promptId });

        // Wait for execution to complete (WebSocket-based)
        // Progress events will transition phase to 'inferring' automatically via onProgress above
        await client.waitForCompletion(promptId);

        // If cancelled during execution, abort without downloading
        if (_cancelled) {
          appendExecutionRecord(ctx, {
            id: `exec_${Date.now()}`,
            timestamp: Date.now(),
            workflowName: customWorkflow.name,
            workflowId: customWorkflow.id,
            mode: customWorkflow.mode,
            params: { ...effectiveParamValues },
            seed: seed ?? null,
            positivePrompt: positivePrompt || null,
            durationMs: null,
            status: 'cancelled',
            envName: activeEnv.name,
          });
          actions.setInteraction({ hud: { message: 'Execution cancelled', type: 'info' } });
          ctx.scoped!.setBusy(false);
          unsubProgress();
          resetExecState();
          return { success: false, error: 'cancelled' };
        }

        // Transition to downloading phase
        setExecPhase('downloading');

        // Fetch result from history (poll with retries — ComfyUI may need time to write)
        // console.log('[ComfyBridge] Fetching history for promptId:', promptId);
        let history = null;
        for (let attempt = 1; attempt <= 5; attempt++) {
          // Wait before each attempt (increasing delay: 500, 1000, 1500, 2000, 2500ms)
          await new Promise(r => setTimeout(r, attempt * 500));
          history = await client.getHistory(promptId);
          // console.log(`[ComfyBridge] History attempt ${attempt}:`, JSON.stringify(history)?.slice(0, 300));
          if (history && history.outputs && Object.keys(history.outputs).length > 0) {
            break; // Got valid history with outputs
          }
        }
        if (!history) {
          throw new Error('Execution completed but history not available');
        }

        // Collect output images from history (only type='output' from SaveImage nodes)
        type OutputImageInfo = { filename: string; subfolder?: string; type: string };
        const allOutputs: OutputImageInfo[] = [];

        for (const nodeOutput of Object.values(history.outputs)) {
          if (nodeOutput.images && nodeOutput.images.length > 0) {
            for (const img of nodeOutput.images) {
              if (img.type === 'output') {
                allOutputs.push({ filename: img.filename, subfolder: img.subfolder || undefined, type: 'output' });
              }
            }
          }
        }

        console.log('[ComfyBridge] Output images:', allOutputs.length, allOutputs.map(o => o.filename));

        if (allOutputs.length === 0) {
          throw new Error('No output image found in execution result (only type="output" images are used)');
        }

        // Download all output images
        // First image → new trunk frame; subsequent images → branches of that frame
        const durationMs = Date.now() - startTime;

        const extraMeta: Record<string, unknown> = {
          ai_generation: true,
          ai_provider: 'ComfyUI',
          ai_workflow: customWorkflow.name,
          ai_mode: customWorkflow.mode,
          ai_positive_prompt: positivePrompt || undefined,
          ai_negative_prompt: negativePrompt || undefined,
          ai_seed: seed,
          ai_duration_ms: durationMs,
          ai_comfy_env: activeEnv.name,
          ai_params: { ...paramValues },
        };

        // Download first image and create trunk frame
        const firstImg = allOutputs[0];
        const firstBlob = await client.downloadOutput(firstImg.filename, firstImg.subfolder, firstImg.type);
        const firstFile = new File([firstBlob], `comfy_${Date.now()}_0.png`, { type: 'image/png' });

        const trunkFrameId = await actions.adv.frame.create.trunk.execute({
          source: firstFile,
          switchFrame: true,
          extra: { ...extraMeta, ai_output_index: 0, ai_output_total: allOutputs.length },
        });

        // For additional outputs, create as branch frames (child of trunk)
        if (allOutputs.length > 1 && trunkFrameId) {
          for (let i = 1; i < allOutputs.length; i++) {
            const img = allOutputs[i];
            const blob = await client.downloadOutput(img.filename, img.subfolder, img.type);
            const file = new File([blob], `comfy_${Date.now()}_${i}.png`, { type: 'image/png' });

            // Create branch frame (parentId = trunk via activeFrame since we did switchFrame: true)
            await actions.adv.frame.create.branch.execute({
              source: file,
              extra: { ...extraMeta, ai_output_index: i, ai_output_total: allOutputs.length },
            });
          }
        }

        const countMsg = allOutputs.length > 1 ? `${allOutputs.length} outputs` : 'new frame';
        actions.setInteraction({
          hud: { message: `✨ ComfyUI result added as ${countMsg} (${(durationMs / 1000).toFixed(1)}s)`, type: 'success' },
        });

        // Record successful execution in history
        appendExecutionRecord(ctx, {
          id: `exec_${Date.now()}`,
          timestamp: Date.now(),
          workflowName: customWorkflow.name,
          workflowId: customWorkflow.id,
          mode: customWorkflow.mode,
          params: { ...effectiveParamValues },
          seed: seed ?? null,
          positivePrompt: positivePrompt || null,
          durationMs,
          status: 'success',
          outputCount: allOutputs.length,
          envName: activeEnv.name,
        });

        ctx.scoped!.setBusy(false);
        unsubProgress();
        resetExecState();
        return { success: true, promptId, durationMs };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn('[ComfyBridge] Workflow execution failed:', errMsg);

        const hudMsg = errMsg.length > 100 ? errMsg.slice(0, 100) + '…' : errMsg;
        actions.setInteraction({ hud: { message: `ComfyUI Error: ${hudMsg}`, type: 'error' } });

        // Record failed execution in history (use config params as fallback)
        appendExecutionRecord(ctx, {
          id: `exec_${Date.now()}`,
          timestamp: Date.now(),
          workflowName: customWorkflow.name,
          workflowId: customWorkflow.id,
          mode: customWorkflow.mode,
          params: { ...(config.workflowParamValues || {}) },
          seed: null,
          positivePrompt: null,
          durationMs: Date.now() - startTime,
          status: 'failed',
          error: errMsg,
          envName: activeEnv.name,
        });

        ctx.scoped!.setBusy(false);
        unsubProgress();
        resetExecState();
        return { success: false, error: errMsg };
      }
    },
  } as EditorCommand<void, Promise<{ success: boolean; promptId?: string; durationMs?: number; error?: string }>>,

  testConnection: {
    id: P.CMD_TEST_CONNECTION,
    name: 'Test ComfyUI Connection',
    execute: async (ctx: EditorContextValue) => {
      const { selfConfig } = ctx.scoped || {};
      const config = selfConfig as ComfyBridgeConfig;

      const envs = config?.environments || [];
      const activeEnv = envs.find(e => e.id === config?.activeEnvironmentId) || envs[0];
      if (!activeEnv?.url) {
        return { success: false, error: 'No environment configured' };
      }

      const client = getClient(activeEnv.url, activeEnv.connectionMode || 'auto');

      try {
        const stats = await client.getSystemStats();
        return { success: true, stats };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return { success: false, error: errMsg };
      }
    },
  } as EditorCommand<void, Promise<{ success: boolean; stats?: unknown; error?: string }>>,

  openSettings: {
    id: P.CMD_OPEN_SETTINGS,
    name: 'Open ComfyUI Settings',
    execute: (ctx: EditorContextValue) => {
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.tab, 'Comfy Bridge');
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.open, true);
    },
  } as EditorCommand<void, void>,
};
