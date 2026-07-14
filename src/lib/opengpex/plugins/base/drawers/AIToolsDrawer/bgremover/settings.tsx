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
import { BgRemoverConfig, BgModelEntry, BUILTIN_MODELS, getBgRemoverModelFiles, DEFAULT_BG_ONNX_FILE } from '../protocols';

/**
 * BgRemoverModelSettings — Model list for background removal.
 *
 * Uses shared useModelSettingsState + ModelSettingsShell, only providing
 * the config adapter and the ONNX filename footer row.
 */
export function BgRemoverModelSettings() {
  const [config, setConfig] = usePluginSelfConfig<BgRemoverConfig>();

  const models = useMemo(() => ensureBuiltins(config.models), [config.models]);
  const getFiles = useCallback((m: BgModelEntry) => getBgRemoverModelFiles(m), []);

  const state = useModelSettingsState({ models, getFiles });

  const updateModel = useCallback((id: string, patch: Partial<BgModelEntry>) => {
    const nextModels = models.map(m => m.id === id ? { ...m, ...patch } : m);
    setConfig({ models: nextModels });
  }, [models, setConfig]);

  const addModel = useCallback(() => {
    const newModel: BgModelEntry = {
      id: `custom-${Date.now()}`,
      name: 'Custom Model',
      modelId: '',
      size: 'Unknown',
      description: 'User-added custom model',
      builtin: false,
    };
    setConfig({ models: [...models, newModel] });
  }, [models, setConfig]);

  const removeModel = useCallback((id: string) => {
    const nextModels = models.filter(m => m.id !== id);
    let nextActiveId = config.activeModelId;
    if (nextActiveId === id && nextModels.length > 0) nextActiveId = nextModels[0].id;
    setConfig({ models: nextModels, activeModelId: nextActiveId });
  }, [config.activeModelId, models, setConfig]);

  return (
    <ModelSettingsShell
      models={models}
      state={state}
      onUpdateModel={updateModel}
      onAddModel={addModel}
      onRemoveModel={removeModel}
      renderFooter={(model) => (
        <>
          {/* ONNX filename row */}
          <div className="flex items-center gap-1.5 px-2.5 pb-2 -mt-0.5 rounded-b-lg border border-t-0 border-[var(--border-subtle)] bg-[var(--bg-stage)]">
            <span className="text-[10px] text-[var(--text-muted)] font-medium shrink-0">ONNX:</span>
            {model.builtin ? (
              <span className="text-[10px] text-[var(--text-secondary)] font-mono truncate">
                {model.onnxFile ?? DEFAULT_BG_ONNX_FILE}
              </span>
            ) : (
              <input
                type="text"
                value={model.onnxFile ?? ''}
                onChange={(e) => updateModel(model.id, { onnxFile: e.target.value || undefined })}
                placeholder={DEFAULT_BG_ONNX_FILE}
                className="flex-1 bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-md px-1.5 py-0.5 text-[10px] text-[var(--text-main)] font-mono focus:outline-none focus:border-[var(--text-secondary)] transition-colors placeholder:text-[var(--text-muted)]"
              />
            )}
          </div>
          {/* Requirement hint for custom models */}
          {!model.builtin && (
            <span className="block text-[9px] text-[var(--text-muted)] italic mt-1 px-2.5">
              ⚠️ Repo must contain preprocessor_config.json + config.json
            </span>
          )}
        </>
      )}
    />
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureBuiltins(models: BgModelEntry[]): BgModelEntry[] {
  const builtinMap = new Map(BUILTIN_MODELS.map(b => [b.id, b]));
  const result = models
    .filter(m => !m.builtin || builtinMap.has(m.id))
    .map(m => {
      const latest = builtinMap.get(m.id);
      return latest ? { ...latest } : m;
    });
  for (const builtin of BUILTIN_MODELS) {
    if (!result.find(m => m.id === builtin.id)) {
      result.unshift(builtin);
    }
  }
  return result;
}
