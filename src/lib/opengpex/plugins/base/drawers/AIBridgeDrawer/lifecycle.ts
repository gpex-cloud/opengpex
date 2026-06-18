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
 * AIBridgeDrawer Lifecycle
 * 
 * Plugin lifecycle hooks, maintained independently of index.tsx.
 * onInit: Called when plugin is registered and mounted
 * onDestroy: Called when plugin is unmounted/destroyed
 */

import { EditorContextValue } from '@opengpex/editor/core/types';
import { AIBridgeConfig, PLUGIN_ID, CMD_FETCH_MODELS } from './protocols';

/**
 * Called during plugin initialization.
 * 
 * - Detects if API Key is configured
 * - If configured and no model cache exists, automatically pre-fetches model list via fetchModels command
 */
export function onInit(ctx: EditorContextValue): void {
  const config = ctx.scoped?.selfConfig as AIBridgeConfig | undefined;

  const hasKey = config?.providers?.some(p => p.apiKey);
  const mode = config?.isMockMode ? 'mock' : hasKey ? 'live' : 'unconfigured';

  console.log(`[${PLUGIN_ID}] Initialized (mode: ${mode})`);

  // Auto-fetch models if API key is configured but no cached models
  if (hasKey && config?.providers) {
    const activeProvider = config.providers.find(p => p.id === config.activeProviderId)
      || config.providers[0];

    if (activeProvider?.apiKey && activeProvider?.baseUrl) {
      const hasCachedModels = (config.cachedModels?.[activeProvider.id]?.length ?? 0) > 0;

      if (!hasCachedModels) {
        // Fire-and-forget: calls fetchModels via command bus to ensure interceptors and history system engage correctly
        ctx.actions.executeCommand(CMD_FETCH_MODELS);
      }
    }
  }
}

/**
 * Called when plugin is destroyed/unmounted.
 */
export function onDestroy(): void {
  console.log(`[${PLUGIN_ID}] Destroyed, cleanup complete.`);
}
