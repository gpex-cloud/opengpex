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
import { AIBridgeConfig, AIMode, AIModelInfo, DEFAULT_PROVIDERS, AIProvider } from './protocols';
import type { AIBridgeDrawerCommandsMap } from './commands.d';

/**
 * useAIBridgeState: Semantic state hook for AIBridge drawer.
 * 
 * Framework has pre-filled complete default values via initialConfig,
 * provider fallback, model list management, and calculated property derivation are handled here.
 */
export function useAIBridgeState() {
  const [config, setSelfConfig] = usePluginSelfConfig<AIBridgeConfig>();
  const { generateCmd, openSettingsCmd, fetchModelsCmd } = usePluginCommands<AIBridgeDrawerCommandsMap>();
  const { activeLayer } = useEditorState();

  // Local loading state (transient, not persisted)
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [fetchModelError, setFetchModelError] = useState<string | null>(null);
  const [isModelFilterFallback, setIsModelFilterFallback] = useState(false);

  // Fetch model list
  const handleFetchModels = useCallback(async () => {
    setIsFetchingModels(true);
    setFetchModelError(null);
    setIsModelFilterFallback(false);
    try {
      const result = await fetchModelsCmd?.execute() as { success: boolean; error?: string; isFilterFallback?: boolean } | undefined;
      if (result && !result.success) {
        setFetchModelError(result.error || 'Unknown error');
      }
      if (result?.isFilterFallback) {
        setIsModelFilterFallback(true);
      }
    } catch (err) {
      setFetchModelError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsFetchingModels(false);
    }
  }, [fetchModelsCmd]);

  return useMemo(() => {
    // Defensive: ensure providers array is never empty
    // Migration: handle old 'endpoint' field → new 'baseUrl' field
    const rawProviders = config.providers?.length ? config.providers : DEFAULT_PROVIDERS;
    const providers = rawProviders.map(p => {
      const pAny = p as unknown as Record<string, unknown>;
      if (!p.baseUrl && typeof pAny['endpoint'] === 'string') {
        // Migrate: strip /v1/images/... suffix from old endpoint
        const oldEndpoint = pAny['endpoint'];
        const baseUrl = oldEndpoint.replace(/\/v1\/images\/(generations|edits|variations)\/?$/i, '')
          .replace(/\/v1\/?$/, '')
          .replace(/\/+$/, '');
        return { ...p, baseUrl };
      }
      return p;
    });

    const activeProvider: AIProvider | undefined =
      providers.find(p => p.id === config.activeProviderId) || providers[0];

    const hasApiKey = Boolean(activeProvider?.apiKey);
    const hasPrompt = Boolean(config.prompt?.trim());
    const mode: AIMode = config.mode || 'generate';

    // Edit/Variations mode requires an active layer
    const hasActiveLayer = Boolean(activeLayer);
    const needsSourceImage = mode === 'edit' || mode === 'variations';

    // Determines if generation is allowed
    const canGenerate = config.isMockMode || (
      hasApiKey &&
      (mode === 'generate' ? hasPrompt : hasActiveLayer) &&
      (mode === 'edit' ? hasPrompt : true) // edit requires prompt, variations does not
    );

    const needsSetup = !hasApiKey && !config.isMockMode;

    // Gets cached model list of the current provider
    const cachedModels: AIModelInfo[] = activeProvider
      ? (config.cachedModels?.[activeProvider.id] || [])
      : [];

    return {
      config: { ...config, providers },
      activeProvider,
      hasApiKey,
      hasPrompt,
      canGenerate,
      needsSetup,
      mode,
      hasActiveLayer,
      needsSourceImage,
      cachedModels,
      isFetchingModels,
      fetchModelError,
      isModelFilterFallback,

      // Actions
      updateConfig: setSelfConfig,
      setMode: (m: AIMode) => setSelfConfig({ mode: m }),
      setModel: (model: string) => {
        if (!activeProvider) return;
        const nextProviders = providers.map(p =>
          p.id === activeProvider.id ? { ...p, model } : p
        );
        setSelfConfig({ providers: nextProviders });
      },
      fetchModels: handleFetchModels,
      generateCmd,
      openSettingsCmd,
    };
  }, [config, setSelfConfig, generateCmd, openSettingsCmd, activeLayer, isFetchingModels, fetchModelError, isModelFilterFallback, handleFetchModels]);
}
