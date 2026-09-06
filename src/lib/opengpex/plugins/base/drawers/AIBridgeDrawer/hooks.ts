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

import { useMemo, useState, useCallback } from 'react';
import { usePluginSelfConfig, usePluginCommands } from '@opengpex/editor/core/context';
import { useEditorState } from '@opengpex/editor/core/context';
import {
  AIBridgeConfig,
  AIEndpoint,
  AIMode,
  AIModelInfo,
  DEFAULT_ENDPOINTS,
  InputSource,
  ModelModality,
  ModelSlot,
  ProviderFeatures,
  getAdapter,
  inferModality,
  modalityWarning,
} from './protocols';
import type { AIBridgeDrawerCommandsMap } from './commands.d';

/** Fills in modality for cached models that predate the annotation. */
function annotateModels(models: AIModelInfo[] | undefined): AIModelInfo[] {
  if (!models) return [];
  return models.map(m => (m.modality ? m : { ...m, modality: inferModality(m.id) }));
}

/** The model slot a mode reads from: Describe wants a vision model, the image
 *  tasks want an image model. */
function slotForMode(mode: AIMode): ModelSlot {
  return mode === 'describe' ? 'multi' : 'image';
}

/**
 * useAIBridgeState: semantic state hook for the AI Bridge drawer.
 *
 * The framework pre-fills defaults through initialConfig; endpoint fallback,
 * model slot resolution and derived flags are handled here.
 */
export function useAIBridgeState() {
  const [config, setSelfConfig] = usePluginSelfConfig<AIBridgeConfig>();
  const { generateCmd, describeCmd, openSettingsCmd, fetchModelsCmd } = usePluginCommands<AIBridgeDrawerCommandsMap>();
  const { activeLayer, activeFrame } = useEditorState();

  // Local loading state (transient, not persisted)
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [fetchModelError, setFetchModelError] = useState<string | null>(null);

  const handleFetchModels = useCallback(async () => {
    setIsFetchingModels(true);
    setFetchModelError(null);
    try {
      const result = await fetchModelsCmd?.execute() as { success: boolean; error?: string } | undefined;
      if (result && !result.success) {
        setFetchModelError(result.error || 'Unknown error');
      }
    } catch (err) {
      setFetchModelError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsFetchingModels(false);
    }
  }, [fetchModelsCmd]);

  return useMemo(() => {
    // Defensive: never operate on an empty endpoint list
    const endpoints: AIEndpoint[] = config.endpoints?.length ? config.endpoints : DEFAULT_ENDPOINTS;
    const activeEndpoint: AIEndpoint | undefined =
      endpoints.find(e => e.id === config.activeEndpointId) || endpoints[0];

    // The provider chosen for this endpoint owns behaviour, capabilities and features
    const provider = getAdapter(activeEndpoint);
    const capabilities = provider.capabilities;
    const features: ProviderFeatures = provider.features;

    // Keep the mode legal for the current provider: switching an endpoint to
    // e.g. Anthropic (no image generation) must not leave the drawer stuck on a
    // tab that can never work. Describe is the universal fallback.
    const requestedMode: AIMode =
      config.mode === 'describe' ? 'describe'
      : config.mode === 'edit' ? 'edit'
      : 'generate';
    const modeAllowed =
      requestedMode === 'describe' ? capabilities.describe
      : requestedMode === 'edit' ? capabilities.edit
      : capabilities.generate;
    const mode: AIMode = modeAllowed
      ? requestedMode
      : capabilities.generate ? 'generate'
      : capabilities.describe ? 'describe'
      : 'generate';

    const hasApiKey = Boolean(activeEndpoint?.apiKey);
    const hasPrompt = Boolean(config.prompt?.trim());

    const inputSource: InputSource = config.inputSource || 'active-layer';
    const hasActiveLayer = Boolean(activeLayer);
    const needsSourceImage = mode === 'edit' || mode === 'describe';
    const hasSource = inputSource === 'merged-frame' ? Boolean(activeFrame) : hasActiveLayer;

    const cachedModels: AIModelInfo[] = annotateModels(
      activeEndpoint ? config.cachedModels?.[activeEndpoint.id] : [],
    );

    // Model for the current task, read from its slot with a sensible fallback
    const slot: ModelSlot = slotForMode(mode);
    const slots = activeEndpoint?.modelByKind || {};
    const activeModel =
      mode === 'describe'
        ? (slots.multi || slots.text || '')
        : (slots.image || slots.multi || '');

    const activeModality: ModelModality =
      cachedModels.find(m => m.id === activeModel)?.modality ?? inferModality(activeModel);

    // Advisory only — a mis-guessed modality must never block the action.
    // The server is the authority on what a model actually supports.
    const modelHint = activeModel
      ? modalityWarning(activeModality, mode === 'describe' ? 'describe' : 'image')
      : null;

    const canGenerate = hasApiKey && Boolean(activeModel) && (
      mode === 'describe'
        ? hasSource
        : hasPrompt && (needsSourceImage ? hasSource : true)
    );

    const needsSetup = !hasApiKey;

    return {
      config: { ...config, endpoints },
      endpoints,
      activeEndpoint,
      provider,
      hasApiKey,
      hasPrompt,
      canGenerate,
      needsSetup,
      mode,
      inputSource,
      hasActiveLayer,
      needsSourceImage,
      cachedModels,
      activeModel,
      activeModality,
      /** Soft warning about the selected model, or null when it looks right */
      modelHint,
      /** Slot the current mode reads from */
      slot,
      /** Hard facts about what this provider can do (drives tab enabling) */
      capabilities,
      features,
      isFetchingModels,
      fetchModelError,

      // Actions
      updateConfig: setSelfConfig,
      setMode: (m: AIMode) => setSelfConfig({ mode: m }),
      /**
       * Selects a model. The target slot follows the model's own modality, so
       * picking a vision model from the list fills the Describe slot with no
       * extra interaction. Pass `slotOverride` to force a specific slot.
       */
      setModel: (model: string, slotOverride?: ModelSlot) => {
        if (!activeEndpoint) return;
        const modality = cachedModels.find(m => m.id === model)?.modality ?? inferModality(model);
        const target: ModelSlot = slotOverride
          ?? (modality === 'text' ? 'text' : modality === 'multi' ? 'multi' : 'image');

        const nextEndpoints = endpoints.map(e =>
          e.id === activeEndpoint.id
            ? { ...e, modelByKind: { ...e.modelByKind, [target]: model } }
            : e,
        );
        setSelfConfig({ endpoints: nextEndpoints });
      },
      setActiveEndpoint: (id: string) => setSelfConfig({ activeEndpointId: id }),
      setInputSource: (src: InputSource) => setSelfConfig({ inputSource: src }),
      fetchModels: handleFetchModels,
      generateCmd,
      describeCmd,
      openSettingsCmd,
    };
  }, [config, setSelfConfig, generateCmd, describeCmd, openSettingsCmd, activeLayer, activeFrame, isFetchingModels, fetchModelError, handleFetchModels]);
}

