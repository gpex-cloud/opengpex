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
 * AIBridgeDrawer Commands
 *
 * Generation logic as independent Commands, per the Plugin Spec.
 *
 * Dispatch is deliberately trivial: each endpoint records which provider it
 * belongs to, so `getAdapter(endpoint)` returns exactly one implementation and
 * that implementation runs. No protocol candidates, no fallback chain — a 404
 * means the selected provider does not match the service, and the error says so.
 */

import { EditorContextValue, EditorCommand } from '@opengpex/editor/core/types';
import { SettingsPanelAPI } from '../../panels/SettingsPanel/protocols';
import { asLocalShape } from '@opengpex/editor/core/types';
import {
  AIBridgeConfig,
  AIEndpoint,
  AIModelInfo,
  GenerationRecord,
  InputSource,
} from './protocols';
import { getAdapter } from './adapters/registry';

import * as P from './protocols';

// ─── Describe instruction ──────────────────────────────────────────────────────

/** Asks for a ready-to-use generation prompt rather than a caption, so the
 *  result can be pasted straight into the Generate prompt box. */
export const DESCRIBE_INSTRUCTION =
  'Describe this image as a text-to-image generation prompt. Output ONLY the prompt itself — a single vivid comma-separated description covering subject, composition, style, lighting and color. No preamble, no quotes, no explanation.';

// ─── Helper: resolve the active endpoint ───────────────────────────────────────

function activeEndpointOf(config: AIBridgeConfig): AIEndpoint | undefined {
  const endpoints = config.endpoints || [];
  return endpoints.find(e => e.id === config.activeEndpointId) || endpoints[0];
}

// ─── Helper: Get source image as Blob for Edit / Describe ──────────────────────
//
// Input source selection:
//   - 'merged-frame': composite ALL visible layers of the active frame
//   - 'active-layer': composite the active layer only (includes transforms /
//     masks / adjustments)
//
async function getInputImageBlob(ctx: EditorContextValue, inputSource: InputSource): Promise<Blob | null> {
  const { activeFrame, pixels } = ctx;
  if (!activeFrame) return null;

  if (inputSource === 'merged-frame') {
    const result = await pixels.render.compositeFrame(activeFrame);
    return await result.toBlob('image/png');
  }

  const { activeLayer } = ctx;
  if (!activeLayer) return null;

  const localRoi = asLocalShape({ x: 0, y: 0, w: activeFrame.canvas.w, h: activeFrame.canvas.h });
  const { result } = await pixels.render.compositeLayers([activeLayer], activeFrame, localRoi, { precision: 8 });
  return await result.toBlob('image/png');
}

// ─── Helper: Append generation record to history ───────────────────────────────

const MAX_HISTORY_RECORDS = 200;

function appendHistoryRecord(
  ctx: EditorContextValue,
  data: Omit<GenerationRecord, 'id' | 'timestamp'>,
): void {
  const { setSelfConfig, selfConfig } = ctx.scoped || {};
  if (!setSelfConfig) return;

  const config = selfConfig as AIBridgeConfig;
  const history = config.generationHistory || [];

  const record: GenerationRecord = {
    ...data,
    id: `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
  };

  setSelfConfig({ generationHistory: [...history, record].slice(-MAX_HISTORY_RECORDS) });
}

// ─── Command Definitions ───────────────────────────────────────────────────────

export const AI_BRIDGE_COMMANDS = {
  generate: {
    id: P.CMD_GENERATE,
    name: 'Generate AI Image',
    execute: async (ctx: EditorContextValue) => {
      const { actions } = ctx;
      const { selfConfig } = ctx.scoped || {};
      const config = selfConfig as AIBridgeConfig;
      const mode = config.mode === 'edit' ? 'edit' : 'generate';

      if (!config?.prompt?.trim() && mode === 'generate') {
        actions.setInteraction({ hud: { message: 'Please enter a prompt first', type: 'info' } });
        return { success: false };
      }

      const endpoint = activeEndpointOf(config);
      if (!endpoint?.apiKey) {
        actions.setInteraction({ hud: { message: 'API Key missing. Configure in Settings.', type: 'error' } });
        return { success: false };
      }

      const adapter = getAdapter(endpoint);
      const model = endpoint.modelByKind?.image || endpoint.modelByKind?.multi || '';

      // Providers without an image API reject early with a clear message; the UI
      // already disables those tabs, this is the safety net.
      if (!adapter.capabilities[mode]) {
        const msg = `${adapter.displayName} does not offer image ${mode === 'edit' ? 'editing' : 'generation'}`;
        actions.setInteraction({ hud: { message: msg, type: 'error' } });
        return { success: false, error: msg };
      }

      const actualSeed = (config.seed ?? -1) === -1
        ? Math.floor(Math.random() * 1_000_000_000)
        : config.seed;
      const size = config.size || '1024x1024';
      const startTime = Date.now();

      // Busy signal survives the drawer being closed and reopened
      ctx.scoped!.setBusy(true);

      try {
        let imageBlob: Blob;

        if (mode === 'generate') {
          imageBlob = await adapter.generate(endpoint, {
            prompt: config.prompt || '',
            negativePrompt: config.negativePrompt || undefined,
            size,
            seed: actualSeed,
          });
        } else {
          const sourceBlob = await getInputImageBlob(ctx, config.inputSource || 'active-layer');
          if (!sourceBlob) {
            actions.setInteraction({ hud: { message: 'Edit mode requires an image source (open a frame with a layer)', type: 'error' } });
            ctx.scoped!.setBusy(false);
            return { success: false };
          }
          imageBlob = await adapter.edit(endpoint, {
            images: [sourceBlob],
            prompt: config.prompt || '',
            negativePrompt: config.negativePrompt || undefined,
            size,
            seed: actualSeed,
          });
        }

        // Build file metadata
        const safeName = endpoint.name.replace(/[^a-zA-Z0-9]/g, '');
        const ext = imageBlob.type === 'image/jpeg' ? 'jpg'
          : imageBlob.type === 'image/webp' ? 'webp'
          : 'png';
        const fileName = `aigen_${safeName}_${mode}_${Date.now()}.${ext}`;
        const file = new File([imageBlob], fileName, { type: imageBlob.type });
        const durationMs = Date.now() - startTime;

        const extra = {
          ai_generation: true,
          ai_provider: endpoint.name,
          // Industry vocabulary, shared with ComfyBridge
          ai_mode: mode === 'generate' ? 'txt2img' : 'img2img',
          ai_positive_prompt: config.prompt,
          ai_negative_prompt: config.negativePrompt,
          ai_seed: actualSeed,
          ai_size: size,
          ai_model: model || undefined,
          ai_duration_ms: durationMs,
        };

        actions.adv.frame.create.trunk.execute({ source: file, switchFrame: false, extra });
        actions.setInteraction({ hud: { message: '✨ AI image added to canvas', type: 'success' } });

        appendHistoryRecord(ctx, {
          provider: endpoint.name,
          model: model || 'unknown',
          mode, kind: 'image', prompt: config.prompt || '', negativePrompt: config.negativePrompt || '',
          seed: actualSeed, size, success: true, durationMs,
        });

        ctx.scoped!.setBusy(false);
        return { success: true, seed: actualSeed };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn('[AIBridge] Generation failed:', errMsg);

        // Known litellm gateway bug: its /images/edits handler mishandles the
        // request as streaming, failing for every model behind that gateway.
        const isLitellmStreamingBug = /streaming request content.*without having called.*read/i.test(errMsg);
        let hudMsg: string;
        if (isLitellmStreamingBug && mode === 'edit') {
          hudMsg = '⚠️ Gateway bug: image editing is broken in your API gateway (litellm). Upgrade litellm or use a direct API endpoint.';
          console.error(
            '[AIBridge] Known litellm bug: the /images/edits handler has a streaming bug affecting all models.\n' +
            'Fix: upgrade litellm, or point this endpoint directly at the provider API.',
          );
        } else {
          const short = errMsg.length > 80 ? errMsg.slice(0, 80) + '…' : errMsg;
          hudMsg = `Generation Failed: ${short}`;
        }
        actions.setInteraction({ hud: { message: hudMsg, type: 'error' } });

        appendHistoryRecord(ctx, {
          provider: endpoint.name,
          model: model || 'unknown',
          mode, kind: 'image', prompt: config.prompt || '', negativePrompt: config.negativePrompt || '',
          seed: actualSeed, size, success: false, error: errMsg, durationMs: Date.now() - startTime,
        });

        ctx.scoped!.setBusy(false);
        return { success: false, error: errMsg };
      }
    },
  } as EditorCommand<void, Promise<{ success: boolean; seed?: number; error?: string }>>,

  describe: {
    id: P.CMD_DESCRIBE,
    name: 'Describe Image',
    execute: async (ctx: EditorContextValue): Promise<{ success: boolean; description?: string; error?: string }> => {
      const { selfConfig } = ctx.scoped || {};
      const config = selfConfig as AIBridgeConfig;

      const endpoint = activeEndpointOf(config);
      if (!endpoint?.apiKey) {
        ctx.actions.setInteraction({ hud: { message: 'API Key missing. Configure in Settings.', type: 'error' } });
        return { success: false };
      }

      const adapter = getAdapter(endpoint);
      const model = endpoint.modelByKind?.multi || endpoint.modelByKind?.text || '';
      const startTime = Date.now();
      ctx.scoped!.setBusy(true);

      try {
        const sourceBlob = await getInputImageBlob(ctx, config.inputSource || 'active-layer');
        if (!sourceBlob) {
          ctx.actions.setInteraction({ hud: { message: 'Describe needs an image — open a frame with a layer', type: 'error' } });
          ctx.scoped!.setBusy(false);
          return { success: false };
        }

        const description = await adapter.describe(endpoint, sourceBlob, DESCRIBE_INSTRUCTION);
        const durationMs = Date.now() - startTime;
        ctx.actions.setInteraction({ hud: { message: '✨ Prompt ready — copy it below', type: 'success' } });

        appendHistoryRecord(ctx, {
          provider: endpoint.name,
          model: model || 'unknown',
          mode: 'describe', kind: 'text', prompt: '(describe: image → prompt)',
          negativePrompt: '', seed: -1, size: '-', success: true, durationMs,
        });

        ctx.scoped!.setBusy(false);
        return { success: true, description };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn('[AIBridge] Describe failed:', errMsg);
        const short = errMsg.length > 80 ? errMsg.slice(0, 80) + '…' : errMsg;
        ctx.actions.setInteraction({ hud: { message: `Describe failed: ${short}`, type: 'error' } });

        appendHistoryRecord(ctx, {
          provider: endpoint.name,
          model: model || 'unknown',
          mode: 'describe', kind: 'text', prompt: '(describe: image → prompt)',
          negativePrompt: '', seed: -1, size: '-', success: false, error: errMsg,
          durationMs: Date.now() - startTime,
        });

        ctx.scoped!.setBusy(false);
        return { success: false, error: errMsg };
      }
    },
  } as EditorCommand<void, Promise<{ success: boolean; description?: string; error?: string }>>,

  fetchModels: {
    id: P.CMD_FETCH_MODELS,
    name: 'Fetch Available Models',
    execute: async (ctx: EditorContextValue) => {
      const { selfConfig, setSelfConfig } = ctx.scoped || {};
      const config = selfConfig as AIBridgeConfig;

      const endpoint = activeEndpointOf(config);
      if (!endpoint?.apiKey || !endpoint?.baseUrl) {
        return { success: false, error: 'Missing API key or base URL' };
      }

      try {
        // The provider decides how to discover models — some expose richer
        // capability data than the standard /v1/models listing.
        const models: AIModelInfo[] = await getAdapter(endpoint).fetchModels(endpoint);

        if (models.length === 0) {
          return { success: false, models: [], error: 'The endpoint returned no models.' };
        }

        // Keep each slot pointing at a model that still exists, preferring one
        // whose modality suits the slot.
        const has = (id?: string) => Boolean(id && models.some(m => m.id === id));
        const firstOf = (...kinds: Array<AIModelInfo['modality']>) =>
          models.find(m => kinds.includes(m.modality))?.id;

        const nextSlots = { ...(endpoint.modelByKind || {}) };
        if (!has(nextSlots.image)) nextSlots.image = firstOf('image', 'multi') || models[0].id;
        if (!has(nextSlots.multi)) nextSlots.multi = firstOf('multi');
        if (!has(nextSlots.text)) nextSlots.text = firstOf('text', 'multi');

        const nextEndpoints = (config.endpoints || []).map(e =>
          e.id === endpoint.id ? { ...e, modelByKind: nextSlots } : e,
        );

        setSelfConfig?.({
          cachedModels: { ...(config.cachedModels || {}), [endpoint.id]: models },
          endpoints: nextEndpoints,
        });

        return { success: true, models };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn('[AIBridge] Fetch models failed:', errMsg);
        return { success: false, error: errMsg };
      }
    },
  } as EditorCommand<void, Promise<{ success: boolean; models?: AIModelInfo[]; error?: string }>>,

  openSettings: {
    id: P.CMD_OPEN_SETTINGS,
    name: 'Open AI Settings',
    execute: (ctx: EditorContextValue) => {
      // Cross-plugin call: uses fully qualified signal storage keys exported by SettingsPanel
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.tab, 'AI Bridge Keys');
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.open, true);
    },
  } as EditorCommand<void, void>,

  toggleAgentChat: {
    id: P.CMD_TOGGLE_AGENT_CHAT,
    name: 'Toggle Agent Chat',
    category: 'AI',
    shortcuts: [{ key: 'k', meta: true }, { key: 'k', ctrl: true }],
    execute: () => {
      window.dispatchEvent(new CustomEvent('editor:toggle-agent-chat'));
    },
  } as EditorCommand<void, void>,
};


