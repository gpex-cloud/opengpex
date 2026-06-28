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
 * Extracts generation logic into independent Command, following commands pattern of Plugin Spec.
 * Supports Generate / Edit / Variations modes.
 */

import { EditorContextValue, EditorCommand } from '@opengpex/editor/core/types';
import { SettingsPanelAPI } from '../../panels/SettingsPanel/protocols';
import { AIBridgeConfig, AIProvider, AIMode, AI_MODE_META, AIModelInfo, GenerationRecord } from './protocols';
import { IMAGE_MODEL_KEYWORDS } from '@opengpex/editor/core/helpers/presets';

import * as P from './protocols';

// ─── Helper: Generate mock image via local Canvas ──────────────────────────────

function createMockImageBlob(_prompt: string, size: string): Promise<Blob> {
  return new Promise((resolve) => {
    const [w, h] = size.split('x').map(Number);
    const canvas = document.createElement('canvas');
    canvas.width = w || 1024;
    canvas.height = h || 1024;
    const ctx = canvas.getContext('2d')!;

    // gradient background
    const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    grad.addColorStop(0, `hsl(${Math.random() * 360}, 70%, 50%)`);
    grad.addColorStop(0.5, `hsl(${Math.random() * 360}, 60%, 40%)`);
    grad.addColorStop(1, `hsl(${Math.random() * 360}, 80%, 30%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // noise overlay
    for (let i = 0; i < 3000; i++) {
      ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.08})`;
      ctx.fillRect(
        Math.random() * canvas.width,
        Math.random() * canvas.height,
        Math.random() * 4 + 1,
        Math.random() * 4 + 1,
      );
    }

    canvas.toBlob((blob) => resolve(blob!), 'image/png');
  });
}

// ─── Helper: Build endpoint URL from base + mode ───────────────────────────────

function buildEndpointUrl(baseUrl: string, mode: AIMode): string {
  const clean = baseUrl.replace(/\/+$/, '');
  return clean + AI_MODE_META[mode].endpoint;
}

// ─── Helper: Proxy fetch — All external requests are proxied via /api/ai-proxy ────────────────

const AI_PROXY_PATH = '/api/ai-proxy';

interface ProxyFetchOptions {
  targetUrl: string;
  apiKey: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: BodyInit | null;
  contentType?: string;
}

async function proxyFetch(opts: ProxyFetchOptions): Promise<Response> {
  const headers: Record<string, string> = {
    'X-Target-URL': opts.targetUrl,
    'X-API-Key': opts.apiKey,
  };
  if (opts.contentType) {
    headers['Content-Type'] = opts.contentType;
  }

  return fetch(AI_PROXY_PATH, {
    method: opts.method || 'POST',
    headers,
    body: opts.body,
  });
}

// ─── Helper: Call OpenAI-compatible Generate endpoint ───────────────────────────

async function callGenerate(
  provider: AIProvider,
  config: AIBridgeConfig,
  seed: number,
): Promise<Blob> {
  const endpoint = buildEndpointUrl(provider.baseUrl, 'generate');

  // OpenAI standard parameters: model, prompt, n, size, quality, style, response_format
  // Extension parameters (non-OpenAI standard, but supported by many compatible APIs): seed, negative_prompt
  const body: Record<string, unknown> = {
    prompt: config.prompt,
    n: 1,
    size: config.size || '1024x1024',        // OpenAI standard
    response_format: 'b64_json',             // OpenAI standard
  };
  if (provider.model) body.model = provider.model;  // OpenAI standard

  // Extension parameters: only sent for non-standard OpenAI models (SD WebUI / ComfyUI, etc.)
  // OpenAI official models (dall-e-*, gpt-image-*) do not support seed/negative_prompt and will return errors
  const isStandardOpenAI = /^(dall-e|gpt-image)/i.test(provider.model || '');
  if (!isStandardOpenAI) {
    if (config.negativePrompt) body.negative_prompt = config.negativePrompt;
    if (seed >= 0) body.seed = seed;
  }

  // Workaround for litellm/Azure gateway bug: gpt-image-1 requests routed through litellm can
  // fail with "Attempted to access streaming request content, without having called `read()`"
  // because litellm's image generation handler incorrectly treats the request as a streaming
  // request. Explicitly setting stream=false forces it onto the non-streaming code path.
  // See: https://github.com/BerriAI/litellm/issues (image generation + Azure)
  if (/^gpt-image/i.test(provider.model || '')) {
    body.stream = false;
  }

  const res = await proxyFetch({
    targetUrl: endpoint,
    apiKey: provider.apiKey,
    method: 'POST',
    body: JSON.stringify(body),
    contentType: 'application/json',
  });

  if (!res.ok) {
    const errData = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(errData.error?.message || `HTTP ${res.status} ${res.statusText}`);
  }

  return extractImageFromResponse(res);
}

// ─── Helper: Call OpenAI-compatible Edit endpoint ──────────────────────────────

async function callEdit(
  provider: AIProvider,
  config: AIBridgeConfig,
  sourceImage: Blob,
  maskImage?: Blob,
): Promise<Blob> {
  const endpoint = buildEndpointUrl(provider.baseUrl, 'edit');
  const formData = new FormData();
  formData.append('image', sourceImage, 'source.png');
  if (maskImage) formData.append('mask', maskImage, 'mask.png');
  formData.append('prompt', config.prompt || '');
  formData.append('n', '1');
  formData.append('size', config.size || '1024x1024');
  formData.append('response_format', 'b64_json');
  if (provider.model) formData.append('model', provider.model);

  const res = await proxyFetch({
    targetUrl: endpoint,
    apiKey: provider.apiKey,
    method: 'POST',
    body: formData,
    // Do not set contentType, let the browser automatically set the multipart boundary
  });

  if (!res.ok) {
    const errData = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(errData.error?.message || `HTTP ${res.status} ${res.statusText}`);
  }

  return extractImageFromResponse(res);
}

// ─── Helper: Call OpenAI-compatible Variations endpoint (multipart) ─────────────

async function callVariations(
  provider: AIProvider,
  config: AIBridgeConfig,
  sourceImage: Blob,
): Promise<Blob> {
  const endpoint = buildEndpointUrl(provider.baseUrl, 'variations');
  const formData = new FormData();
  formData.append('image', sourceImage, 'source.png');
  formData.append('n', '1');
  formData.append('size', config.size || '1024x1024');
  formData.append('response_format', 'b64_json');
  if (provider.model) formData.append('model', provider.model);

  const res = await proxyFetch({
    targetUrl: endpoint,
    apiKey: provider.apiKey,
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const errData = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(errData.error?.message || `HTTP ${res.status} ${res.statusText}`);
  }

  return extractImageFromResponse(res);
}

// ─── Helper: Extract image blob from API response ──────────────────────────────

async function extractImageFromResponse(res: Response): Promise<Blob> {
  const data = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
  const item = data.data?.[0];

  if (item?.b64_json) {
    const binary = atob(item.b64_json);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: 'image/png' });
  } else if (item?.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) throw new Error('Failed to fetch image from returned URL');
    return await imgRes.blob();
  }

  throw new Error('Invalid API response: no image data found');
}

// ─── Helper: Get active canvas layer as Blob (for Edit/Variations) ─────────────

async function getActiveLayerBlob(ctx: EditorContextValue): Promise<Blob | null> {
  const { activeLayer, assets } = ctx;
  if (!activeLayer) return null;

  // Gets asset URL corresponding to layer via AssetService
  const url = assets.getURL(activeLayer.assetId);
  if (!url) return null;

  const res = await fetch(url);
  return res.blob();
}

// ─── Helper: Append generation record to history ───────────────────────────────

const MAX_HISTORY_RECORDS = 200;

function appendHistoryRecord(
  ctx: EditorContextValue,
  data: Omit<GenerationRecord, 'id' | 'timestamp'>,
): void {
  const { setSelfConfig, selfConfig } = ctx.scoped || {};
  if (!setSelfConfig) return;

  const config = selfConfig as AIBridgeConfig & { generationHistory?: GenerationRecord[] };
  const history = config.generationHistory || [];

  const record: GenerationRecord = {
    ...data,
    id: `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
  };

  // Keep the most recent MAX_HISTORY_RECORDS records
  const nextHistory = [...history, record].slice(-MAX_HISTORY_RECORDS);
  setSelfConfig({ generationHistory: nextHistory });
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

      if (!config?.prompt?.trim() && config?.mode === 'generate' && !config?.isMockMode) {
        actions.setInteraction({ hud: { message: 'Please enter a prompt first', type: 'info' } });
        return { success: false };
      }

      const providers = config.providers || [];
      const activeProvider = providers.find(p => p.id === config.activeProviderId) || providers[0];

      if (!activeProvider?.apiKey && !config.isMockMode) {
        actions.setInteraction({ hud: { message: 'API Key missing. Configure in Settings.', type: 'error' } });
        return { success: false };
      }

      const actualSeed = (config.seed ?? -1) === -1
        ? Math.floor(Math.random() * 1_000_000_000)
        : config.seed;
      const size = config.size || '1024x1024';
      const mode = config.mode || 'generate';
      const startTime = Date.now();
      // Sets generating signal (not lost when drawer is closed and reopened, auto-prefixed with plugin uid via scoped)
      ctx.scoped!.setBusy(true);

      try {
        let imageBlob: Blob;

        if (config.isMockMode) {
          await new Promise(r => setTimeout(r, 1200));
          imageBlob = await createMockImageBlob(config.prompt || '', size);
        } else if (mode === 'generate') {
          imageBlob = await callGenerate(activeProvider, config, actualSeed);
        } else if (mode === 'edit') {
          const sourceBlob = await getActiveLayerBlob(ctx);
          if (!sourceBlob) {
            actions.setInteraction({ hud: { message: 'Edit mode requires an active image layer', type: 'error' } });
            return { success: false };
          }
          imageBlob = await callEdit(activeProvider, config, sourceBlob);
        } else {
          // variations
          const sourceBlob = await getActiveLayerBlob(ctx);
          if (!sourceBlob) {
            actions.setInteraction({ hud: { message: 'Variations mode requires an active image layer', type: 'error' } });
            return { success: false };
          }
          imageBlob = await callVariations(activeProvider, config, sourceBlob);
        }

        // Build file metadata
        const safeProviderName = (config.isMockMode ? 'MockMode' : activeProvider.name)
          .replace(/[^a-zA-Z0-9]/g, '');
        const ext = imageBlob.type === 'image/jpeg' ? 'jpg'
          : imageBlob.type === 'image/webp' ? 'webp'
          : 'png';
        const fileName = `aigen_${safeProviderName}_${mode}_${Date.now()}.${ext}`;
        const file = new File([imageBlob], fileName, { type: imageBlob.type });

        const extra = {
          ai_generation: true,
          ai_provider: config.isMockMode ? 'Mock Mode' : activeProvider.name,
          ai_mode: mode,
          ai_prompt: config.prompt,
          ai_negative_prompt: config.negativePrompt,
          ai_seed: actualSeed,
          ai_size: size,
          ai_model: activeProvider?.model || undefined,
        };

        actions.adv.frame.create.trunk.execute({ source: file, switchFrame: false, extra });
        actions.setInteraction({ hud: { message: '✨ AI image added to canvas', type: 'success' } });

        // Record successful history
        const durationMs = Date.now() - startTime;
        appendHistoryRecord(ctx, {
          provider: config.isMockMode ? 'Mock Mode' : activeProvider.name,
          model: activeProvider?.model || 'unknown',
          mode, prompt: config.prompt || '', negativePrompt: config.negativePrompt || '',
          seed: actualSeed, size, success: true, durationMs,
        });

        ctx.scoped!.setBusy(false);
        return { success: true, seed: actualSeed };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn('[AIBridge] Generation failed:', errMsg);

        // Detect known litellm gateway bug: /images/edits and /images/variations endpoints
        // are broken in certain litellm versions — they fail with a streaming request error
        // regardless of model or provider. This is a server-side bug, not a client issue.
        const isLitellmStreamingBug = /streaming request content.*without having called.*read/i.test(errMsg);
        let hudMsg: string;
        if (isLitellmStreamingBug && mode !== 'generate') {
          hudMsg = '⚠️ Gateway bug: image edit/variations not supported by your API gateway (litellm). Please upgrade litellm or use a direct API endpoint.';
          console.error(
            '[AIBridge] Known litellm bug detected: the /images/edits endpoint handler in litellm has a streaming bug.\n' +
            'This affects ALL models when using Edit/Variations mode through litellm.\n' +
            'Fix: upgrade litellm to a version that fixes this issue, or connect directly to the provider API.',
          );
        } else {
          hudMsg = errMsg.length > 80 ? errMsg.slice(0, 80) + '…' : errMsg;
          hudMsg = `Generation Failed: ${hudMsg}`;
        }
        actions.setInteraction({ hud: { message: hudMsg, type: 'error' } });

        // Record failed history
        const durationMs = Date.now() - startTime;
        appendHistoryRecord(ctx, {
          provider: config.isMockMode ? 'Mock Mode' : activeProvider.name,
          model: activeProvider?.model || 'unknown',
          mode, prompt: config.prompt || '', negativePrompt: config.negativePrompt || '',
          seed: actualSeed, size, success: false, error: errMsg, durationMs,
        });

        ctx.scoped!.setBusy(false);
        return { success: false, error: errMsg };
      }
    },
  } as EditorCommand<void, Promise<{ success: boolean; seed?: number; error?: string }>>,

  fetchModels: {
    id: P.CMD_FETCH_MODELS,
    name: 'Fetch Available Models',
    execute: async (ctx: EditorContextValue) => {
      const { selfConfig, setSelfConfig } = ctx.scoped || {};
      const config = selfConfig as AIBridgeConfig;

      const providers = config?.providers || [];
      const activeProvider = providers.find(p => p.id === config?.activeProviderId) || providers[0];

      if (!activeProvider?.apiKey || !activeProvider?.baseUrl) {
        return { success: false, error: 'Missing API key or base URL' };
      }

      try {
        const modelsUrl = `${activeProvider.baseUrl.replace(/\/+$/, '')}/v1/models`;
        const res = await proxyFetch({
          targetUrl: modelsUrl,
          apiKey: activeProvider.apiKey,
          method: 'GET',
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }

        const data = (await res.json()) as { data?: AIModelInfo[] };
        const allModels: AIModelInfo[] = data.data || [];

        // Filtering strategy: uses the image model keyword whitelist maintained in presets.ts
        const imageModels = allModels.filter(m =>
          IMAGE_MODEL_KEYWORDS.some(kw => m.id.toLowerCase().includes(kw.toLowerCase()))
        );

        // If no image model matches, fall back to the entire list
        const finalModels = imageModels.length > 0 ? imageModels : allModels;
        const isFilterFallback = imageModels.length === 0 && allModels.length > 0;

        // Update cache
        const nextCachedModels = {
          ...(config.cachedModels || {}),
          [activeProvider.id]: finalModels,
        };

        setSelfConfig?.({ cachedModels: nextCachedModels });

        return { success: true, models: finalModels, isFilterFallback };
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
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.tab, 'API Keys');
      ctx.actions.setStateSignal(SettingsPanelAPI.signals.open, true);
    },
  } as EditorCommand<void, void>,
};
