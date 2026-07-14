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
import type { BgRemoverConfig } from '../protocols';
import type { SegConfig, SegModelEntry } from './protocols';
import { BUILTIN_SEG_MODELS, DEFAULT_SEG_CONFIG, DEFAULT_SEG_ENCODER_FILE, DEFAULT_SEG_DECODER_FILE, getSegModelFiles } from './protocols';

/**
 * SegmentationModelSettings — Model list for segmentation.
 *
 * Uses shared useModelSettingsState + ModelSettingsShell, only providing
 * the config adapter and the encoder/decoder footer row.
 */
export function SegmentationModelSettings() {
  const [config, setConfig] = usePluginSelfConfig<BgRemoverConfig & { seg?: SegConfig }>();
  const segConfig = config.seg ?? DEFAULT_SEG_CONFIG;

  const models = useMemo(() => ensureBuiltins(segConfig.models), [segConfig.models]);
  const getFiles = useCallback((m: SegModelEntry) => getSegModelFiles(m), []);

  const state = useModelSettingsState({ models, getFiles });

  const updateModel = useCallback((id: string, patch: Partial<SegModelEntry>) => {
    const nextModels = models.map(m => m.id === id ? { ...m, ...patch } : m);
    setConfig({ ...config, seg: { ...segConfig, models: nextModels } });
  }, [models, config, segConfig, setConfig]);

  const addModel = useCallback(() => {
    const newModel: SegModelEntry = {
      id: `custom-seg-${Date.now()}`,
      name: 'Custom SAM Model',
      modelId: '',
      size: 'Unknown',
      description: 'User-added custom segmentation model',
      builtin: false,
      type: 'interactive',
    };
    setConfig({ ...config, seg: { ...segConfig, models: [...models, newModel] } });
  }, [config, segConfig, models, setConfig]);

  const removeModel = useCallback((id: string) => {
    const nextModels = models.filter(m => m.id !== id);
    let nextActiveId = segConfig.activeModelId;
    if (nextActiveId === id && nextModels.length > 0) nextActiveId = nextModels[0].id;
    setConfig({ ...config, seg: { ...segConfig, models: nextModels, activeModelId: nextActiveId } });
  }, [config, segConfig, models, setConfig]);

  return (
    <ModelSettingsShell
      models={models}
      state={state}
      onUpdateModel={updateModel}
      onAddModel={addModel}
      onRemoveModel={removeModel}
      getBadge={(m) => m.type === 'auto' ? 'Auto' : 'Interactive'}
      renderFooter={(model) => (
        <div className="flex flex-col gap-1 px-2.5 pb-2 -mt-0.5 rounded-b-lg border border-t-0 border-[var(--border-subtle)] bg-[var(--bg-stage)]">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[var(--text-muted)] font-medium shrink-0 w-[52px]">Encoder:</span>
            {model.builtin ? (
              <span className="text-[10px] text-[var(--text-secondary)] font-mono truncate">
                {model.encoderFile ?? DEFAULT_SEG_ENCODER_FILE}
              </span>
            ) : (
              <input
                type="text"
                value={model.encoderFile ?? ''}
                onChange={(e) => updateModel(model.id, { encoderFile: e.target.value || undefined })}
                placeholder={DEFAULT_SEG_ENCODER_FILE}
                className="flex-1 bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-md px-1.5 py-0.5 text-[10px] text-[var(--text-main)] font-mono focus:outline-none focus:border-[var(--text-secondary)] transition-colors placeholder:text-[var(--text-muted)]"
              />
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[var(--text-muted)] font-medium shrink-0 w-[52px]">Decoder:</span>
            {model.builtin ? (
              <span className="text-[10px] text-[var(--text-secondary)] font-mono truncate">
                {model.decoderFile ?? DEFAULT_SEG_DECODER_FILE}
              </span>
            ) : (
              <input
                type="text"
                value={model.decoderFile ?? ''}
                onChange={(e) => updateModel(model.id, { decoderFile: e.target.value || undefined })}
                placeholder={DEFAULT_SEG_DECODER_FILE}
                className="flex-1 bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-md px-1.5 py-0.5 text-[10px] text-[var(--text-main)] font-mono focus:outline-none focus:border-[var(--text-secondary)] transition-colors placeholder:text-[var(--text-muted)]"
              />
            )}
          </div>
        </div>
      )}
    />
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureBuiltins(models: SegModelEntry[]): SegModelEntry[] {
  const builtinMap = new Map(BUILTIN_SEG_MODELS.map(b => [b.id, b]));
  const result = models
    .filter(m => !m.builtin || builtinMap.has(m.id))
    .map(m => {
      const latest = builtinMap.get(m.id);
      return latest ? { ...latest } : m;
    });
  for (const builtin of BUILTIN_SEG_MODELS) {
    if (!result.find(m => m.id === builtin.id)) {
      result.unshift(builtin);
    }
  }
  return result;
}
