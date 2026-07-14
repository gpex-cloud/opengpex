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

import { useCallback, useMemo } from 'react';
import { usePluginSelfConfig } from '@opengpex/editor/core/context';
import { useModelSettingsState, ModelSettingsShell } from '../shared';
import type { AIToolsConfig, UpscaleConfig, UpscaleModelEntry } from '../protocols';
import { BUILTIN_UPSCALE_MODELS, DEFAULT_UPSCALE_CONFIG, getUpscaleModelFiles } from '../protocols';

/**
 * UpscalerModelSettings — Model list for AI upscaling.
 *
 * Uses shared useModelSettingsState + ModelSettingsShell, only providing
 * the config adapter and the ONNX filename footer row.
 */
export function UpscalerModelSettings() {
  const [config, setConfig] = usePluginSelfConfig<AIToolsConfig>();
  const upConfig: UpscaleConfig = config?.upscale ?? DEFAULT_UPSCALE_CONFIG;

  const models = useMemo(() => ensureBuiltins(upConfig.models ?? []), [upConfig.models]);
  const getFiles = useCallback((m: UpscaleModelEntry) => getUpscaleModelFiles(m), []);

  const state = useModelSettingsState({ models, getFiles });

  const updateModel = useCallback((id: string, patch: Partial<UpscaleModelEntry>) => {
    const nextModels = models.map(m => m.id === id ? { ...m, ...patch } : m);
    setConfig({ upscale: { ...upConfig, models: nextModels } });
  }, [models, upConfig, setConfig]);

  const addModel = useCallback(() => {
    const newModel: UpscaleModelEntry = {
      id: `custom-${Date.now()}`,
      name: 'Custom Upscale Model',
      modelId: '',
      size: 'Unknown',
      scale: 4,
      description: 'User-added custom upscale model',
      builtin: false,
    };
    setConfig({ upscale: { ...upConfig, models: [...models, newModel] } });
  }, [models, upConfig, setConfig]);

  const removeModel = useCallback((id: string) => {
    const nextModels = models.filter(m => m.id !== id);
    let nextActiveId = upConfig.activeModelId;
    if (nextActiveId === id && nextModels.length > 0) nextActiveId = nextModels[0].id;
    setConfig({ upscale: { ...upConfig, models: nextModels, activeModelId: nextActiveId } });
  }, [upConfig, models, setConfig]);

  return (
    <ModelSettingsShell
      models={models}
      state={state}
      onUpdateModel={updateModel}
      onAddModel={addModel}
      onRemoveModel={removeModel}
      getBadge={(m) => `${m.scale}×`}
      renderFooter={(model) => (
        <div className="flex items-center gap-1.5 px-2.5 pb-2 -mt-0.5 rounded-b-lg border border-t-0 border-[var(--border-subtle)] bg-[var(--bg-stage)]">
          <span className="text-[9px] text-[var(--text-muted)] font-medium shrink-0">ONNX:</span>
          {model.builtin ? (
            <span className="text-[9px] text-[var(--text-secondary)] font-mono truncate">
              {model.onnxFile ?? 'model.onnx'}
            </span>
          ) : (
            <input
              type="text"
              value={model.onnxFile ?? ''}
              onChange={(e) => updateModel(model.id, { onnxFile: e.target.value || undefined })}
              placeholder="model.onnx"
              className="flex-1 bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-md px-1.5 py-0.5 text-[9px] text-[var(--text-main)] font-mono focus:outline-none focus:border-[var(--text-secondary)] transition-colors placeholder:text-[var(--text-muted)]"
            />
          )}
        </div>
      )}
    />
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureBuiltins(models: UpscaleModelEntry[]): UpscaleModelEntry[] {
  const builtinMap = new Map(BUILTIN_UPSCALE_MODELS.map(b => [b.id, b]));
  const result = models
    .filter(m => !m.builtin || builtinMap.has(m.id))
    .map(m => {
      const latest = builtinMap.get(m.id);
      return latest ? { ...latest } : m;
    });
  for (const builtin of BUILTIN_UPSCALE_MODELS) {
    if (!result.find(m => m.id === builtin.id)) {
      result.unshift(builtin);
    }
  }
  return result;
}
