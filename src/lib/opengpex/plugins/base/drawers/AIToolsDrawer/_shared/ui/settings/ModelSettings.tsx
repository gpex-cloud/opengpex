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

/**
 * ModelSettings — Declarative, self-contained AI model settings panel.
 *
 * Combines useModelSettings() + ModelSettingsShell + file field rendering
 * into a single component. Consumers only need to provide a config object —
 * no render-props, no wrapper components.
 *
 * Replaces the previous pattern of:
 *   useModelSettings() → <ModelSettingsShell settings={...} renderFooter={...} />
 *
 * @example
 * ```tsx
 * <ModelSettings<UpscaleModelEntry>
 *   configKey="upscaler"
 *   defaultConfig={DEFAULT_UPSCALE_CONFIG}
 *   builtins={BUILTIN_UPSCALE_MODELS}
 *   defaultNewModel={() => ({ ... })}
 *   getFiles={(m) => [{ filename: m.onnxFile ?? 'model.onnx' }]}
 *   getBadge={(m) => `${m.scale}×`}
 *   fileFields={[{ key: 'onnxFile', label: 'ONNX', placeholder: 'model.onnx' }]}
 * />
 * ```
 */

import { useCallback, useRef } from 'react';
import { Plus } from 'lucide-react';
import { ModelCard } from './ModelCard';
import { useModelSettings } from './useModelSettings';
import type { UseModelSettingsOptions } from './useModelSettings';
import type { ModelEntry } from '../../types';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Declarative file field descriptor for the footer section of each model card.
 */
export interface FileFieldDescriptor<T extends ModelEntry> {
  /** Model property key that stores the filename (e.g. 'onnxFile', 'encoderFile') */
  key: string & keyof T;
  /** Label shown before the filename (e.g. 'ONNX', 'Encoder') */
  label: string;
  /** Placeholder for custom model input */
  placeholder: string;
  /** Optional suffix text derived from model (e.g. "512×512") — shown at end of row */
  suffix?: (model: T) => string | undefined;
}

/**
 * Props for the ModelSettings component.
 */
export interface ModelSettingsProps<T extends ModelEntry> extends UseModelSettingsOptions<T> {
  /** Optional badge text derived from model (e.g. "4×", "Interactive") */
  getBadge?: (model: T) => string | undefined;
  /**
   * File field descriptors for the footer.
   * Each entry renders a row showing the filename (read-only for builtins, editable for customs).
   */
  fileFields?: FileFieldDescriptor<T>[];
  /** Optional hint shown below custom model file fields */
  customModelHint?: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ModelSettings<T extends ModelEntry>(props: ModelSettingsProps<T>) {
  const {
    configKey,
    defaultConfig,
    builtins,
    defaultNewModel,
    getFiles,
    getBadge,
    fileFields,
    customModelHint,
  } = props;

  const settings = useModelSettings<T>({
    configKey,
    toolDisplayName: props.toolDisplayName,
    defaultConfig,
    builtins,
    defaultNewModel,
    getFiles,
  });

  const {
    models,
    updateModel,
    addModel,
    removeModel,
    cacheStatus,
    busyModels,
    isDownloading,
    task,
    handleDownload,
    handleCancelDownload,
    handleDeleteCache,
    handleExport,
    handleImport,
  } = settings;

  // ─── Import file input handling ─────────────────────────────────────────
  const importInputRef = useRef<HTMLInputElement>(null);
  const importModelIdRef = useRef<string>('');

  const handleImportClick = useCallback((modelId: string) => {
    importModelIdRef.current = modelId;
    importInputRef.current?.click();
  }, []);

  const handleImportFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && importModelIdRef.current) {
      handleImport(importModelIdRef.current, file);
    }
    // Reset input so the same file can be re-selected
    e.target.value = '';
  }, [handleImport]);

  return (
    <div className="flex flex-col gap-3">
      {/* Hidden file input for import */}
      <input
        ref={importInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={handleImportFile}
      />

      {/* ─── Toolbar: Add custom model ─────────────────────────── */}
      <div className="flex items-center justify-end">
        <button
          onClick={addModel}
          className="flex items-center gap-1 text-[9px] font-bold text-[var(--text-secondary)] hover:text-[var(--text-main)] transition-colors uppercase tracking-wider"
        >
          <Plus size={10} /> Add Custom
        </button>
      </div>

      {/* ─── Model List ───────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        {models.map((model) => {
          const downloading = task?.modelId === model.modelId && isDownloading;
          const hasFileFields = fileFields && fileFields.length > 0;
          return (
            <div key={model.id} className={hasFileFields ? 'flex flex-col gap-0' : ''}>
              <ModelCard
                model={{
                  ...model,
                  badge: getBadge?.(model),
                }}
                isCached={!!cacheStatus[model.modelId]}
                isBusy={!!busyModels[model.modelId]}
                isAnyDownloading={isDownloading}
                downloadProgress={downloading ? {
                  progress: task!.progress.overallTotal > 0 ? task!.progress.overallLoaded / task!.progress.overallTotal : 0,
                  loadedBytes: task!.progress.overallLoaded,
                  totalBytes: task!.progress.overallTotal,
                  speedBps: task!.progress.speedBps,
                  currentFile: task!.progress.currentFile,
                } : undefined}
                onNameChange={(name) => updateModel(model.id, { name } as Partial<T>)}
                onModelIdChange={(modelId) => updateModel(model.id, { modelId } as Partial<T>)}
                onDownload={() => handleDownload(model.modelId)}
                onDelete={() => handleDeleteCache(model.modelId)}
                onRemove={!model.builtin ? () => removeModel(model.id) : undefined}
                onCancelDownload={handleCancelDownload}
                onExport={() => handleExport(model.modelId)}
                onImport={() => handleImportClick(model.modelId)}
              />
              {/* ─── File Fields Footer ──────────────────────────── */}
              {hasFileFields && (
                <div className="flex flex-col gap-1 px-2.5 pb-2 -mt-0.5 rounded-b-lg border border-t-0 border-[var(--border-subtle)] bg-[var(--bg-stage)]">
                  {fileFields!.map((field) => (
                    <div key={field.key} className="flex items-center gap-1.5">
                      <span className="text-[10px] text-[var(--text-muted)] font-medium shrink-0">
                        {field.label}:
                      </span>
                      {model.builtin ? (
                        <span className="text-[10px] text-[var(--text-secondary)] font-mono truncate">
                          {(model as Record<string, unknown>)[field.key] as string ?? field.placeholder}
                        </span>
                      ) : (
                        <input
                          type="text"
                          value={(model as Record<string, unknown>)[field.key] as string ?? ''}
                          onChange={(e) => updateModel(model.id, { [field.key]: e.target.value || undefined } as Partial<T>)}
                          placeholder={field.placeholder}
                          className="flex-1 bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-md px-1.5 py-0.5 text-[10px] text-[var(--text-main)] font-mono focus:outline-none focus:border-[var(--text-secondary)] transition-colors placeholder:text-[var(--text-muted)]"
                        />
                      )}
                      {field.suffix && (
                        <span className="text-[9px] text-[var(--text-muted)] shrink-0 ml-auto">
                          {field.suffix(model)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {/* ─── Custom Model Hint ────────────────────────────── */}
              {!model.builtin && customModelHint && (
                <span className="block text-[10px] text-[var(--text-muted)] italic mt-1 px-2.5">
                  ⚠️ {customModelHint}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
