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

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePluginSelfConfig } from "@opengpex/editor/core/context";
import { Cpu, Plus, Trash2, Lock, Download, CheckCircle2, Loader2 } from "lucide-react";
import { BgRemovalConfig, BgModelEntry, BUILTIN_MODELS } from "../protocols";

// ─── Cache Helpers ───────────────────────────────────────────────────────────

async function isModelCached(modelId: string): Promise<boolean> {
  try {
    const cacheNames = await caches.keys();
    const tfCaches = cacheNames.filter(
      n => n.includes('transformers') || n.includes('onnx') || n.includes('huggingface')
    );
    for (const name of tfCaches) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      if (keys.some(r => r.url.includes(modelId) || r.url.includes(modelId.replace('/', '%2F')))) return true;
    }
    return false;
  } catch { return false; }
}

async function deleteModelCache(modelId: string): Promise<boolean> {
  try {
    let deleted = false;
    const cacheNames = await caches.keys();
    const tfCaches = cacheNames.filter(
      n => n.includes('transformers') || n.includes('onnx') || n.includes('huggingface')
    );
    for (const name of tfCaches) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      for (const req of keys) {
        if (req.url.includes(modelId) || req.url.includes(modelId.replace('/', '%2F'))) {
          await cache.delete(req);
          deleted = true;
        }
      }
    }
    return deleted;
  } catch { return false; }
}

/**
 * BgRemovalModelSettings — Settings panel for managing background removal models.
 *
 * Registered via contributions to SETTINGS_CONFIG_PANEL.
 * Allows users to:
 *   - View built-in models (locked, cannot edit/delete)
 *   - Add custom models (name + HuggingFace model ID)
 *   - Remove custom models
 */
export function BgRemovalModelSettings() {
  const [config, setConfig] = usePluginSelfConfig<BgRemovalConfig>();
  const [cacheStatus, setCacheStatus] = useState<Record<string, boolean>>({});
  const [busyModels, setBusyModels] = useState<Record<string, boolean>>({});

  // Ensure built-in models are always present (migration safety)
  const models = useMemo(() => ensureBuiltins(config.models), [config.models]);

  // Check cache status for all models on mount and when models change
  useEffect(() => {
    let cancelled = false;
    const checkAll = async () => {
      const result: Record<string, boolean> = {};
      for (const model of models) {
        if (model.modelId) {
          result[model.modelId] = await isModelCached(model.modelId);
        }
      }
      if (!cancelled) setCacheStatus(result);
    };
    checkAll();
    return () => { cancelled = true; };
  }, [models]);

  const handleDownload = useCallback(async (modelId: string) => {
    // We can't actually trigger download from settings (no image context).
    // Instead, mark a note — the model will auto-download on first use.
    // For now this is a no-op placeholder that could pre-warm the model.
    setBusyModels(prev => ({ ...prev, [modelId]: true }));
    // Simulate: the actual download happens when user runs inference
    setTimeout(() => {
      setBusyModels(prev => ({ ...prev, [modelId]: false }));
    }, 500);
  }, []);

  const handleDeleteCache = useCallback(async (modelId: string) => {
    setBusyModels(prev => ({ ...prev, [modelId]: true }));
    const deleted = await deleteModelCache(modelId);
    if (deleted) {
      setCacheStatus(prev => ({ ...prev, [modelId]: false }));
    }
    setBusyModels(prev => ({ ...prev, [modelId]: false }));
  }, []);

  const updateModel = (id: string, patch: Partial<BgModelEntry>) => {
    const nextModels = models.map((m) =>
      m.id === id ? { ...m, ...patch } : m,
    );
    setConfig({ models: nextModels });
  };

  const addModel = () => {
    const newId = `custom-${Date.now()}`;
    const newModel: BgModelEntry = {
      id: newId,
      name: "Custom Model",
      modelId: "",
      size: "Unknown",
      description: "User-added custom model",
      builtin: false,
    };
    setConfig({ models: [...models, newModel] });
  };

  const removeModel = (id: string) => {
    const nextModels = models.filter((m) => m.id !== id);
    // If the deleted model was active, switch to the first available
    let nextActiveId = config.activeModelId;
    if (nextActiveId === id && nextModels.length > 0) {
      nextActiveId = nextModels[0].id;
    }
    setConfig({ models: nextModels, activeModelId: nextActiveId });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between pl-1">
          <h5 className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest flex items-center gap-1.5">
            <Cpu size={11} /> Background Removal Models
          </h5>
          <button
            onClick={addModel}
            className="flex items-center gap-1 text-[9px] font-bold text-amber-500 hover transition-colors uppercase tracking-wider"
          >
            <Plus size={10} /> Add
          </button>
        </div>

        <div className="flex flex-col gap-3 max-h-[400px] overflow-y-auto pr-1">
          {models.map((model) => (
            <div
              key={model.id}
              className="flex flex-col gap-2.5 rounded-xl p-3 border bg-[var(--bg-stage)] border-[var(--border-subtle)] transition-all"
            >
              {/* Header: Name and actions */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-1">
                  {model.builtin && (
                    <Lock size={10} className="text-amber-500/60 shrink-0" />
                  )}
                  {model.builtin ? (
                    <span className="text-[11px] font-bold text-[var(--text-main)]">
                      {model.name}
                    </span>
                  ) : (
                    <input
                      type="text"
                      value={model.name}
                      onChange={(e) =>
                        updateModel(model.id, { name: e.target.value })
                      }
                      className="bg-transparent border-none text-[11px] font-bold text-[var(--text-main)] focus:outline-none w-32 focus:ring-1 focus:ring-amber-500/50 rounded px-1 -ml-1"
                    />
                  )}
                </div>
                {!model.builtin && (
                  <button
                    onClick={() => removeModel(model.id)}
                    className="text-[var(--text-muted)] hover:text-rose-500 transition-colors p-1"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>

              {/* Model ID input */}
              <div className="flex flex-col gap-1">
                <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-wider pl-0.5 flex items-center gap-1">
                  <Cpu size={9} /> HuggingFace Model ID
                </span>
                {model.builtin ? (
                  <span className="text-[10px] text-[var(--text-secondary)] font-mono pl-0.5">
                    {model.modelId}
                  </span>
                ) : (
                  <input
                    type="text"
                    value={model.modelId}
                    onChange={(e) =>
                      updateModel(model.id, { modelId: e.target.value })
                    }
                    placeholder="owner/model-name"
                    className="w-full bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-lg px-2 py-1.5 text-[10px] text-[var(--text-main)] focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all placeholder:text-[var(--text-muted)]"
                  />
                )}
              </div>

              {/* Size & description */}
              <div className="flex justify-between items-center">
                <span className="text-[9px] text-[var(--text-muted)]">
                  {model.size}
                </span>
                <span className="text-[9px] text-[var(--text-muted)] italic">
                  {model.description}
                </span>
              </div>

              {/* Cache status + Download/Delete */}
              {model.modelId && (
                <div className="flex items-center justify-between pt-1 border-t border-[var(--border-subtle)]">
                  <span className="text-[8px] flex items-center gap-1">
                    {cacheStatus[model.modelId] ? (
                      <span className="text-emerald-400 flex items-center gap-0.5">
                        <CheckCircle2 size={9} /> Cached
                      </span>
                    ) : (
                      <span className="text-[var(--text-muted)] italic">Not downloaded</span>
                    )}
                  </span>
                  <div className="flex gap-1">
                    {!cacheStatus[model.modelId] && (
                      <button
                        onClick={() => handleDownload(model.modelId)}
                        disabled={busyModels[model.modelId]}
                        className="flex items-center gap-0.5 text-[8px] font-bold text-amber-500 hover:text-amber-400 disabled:opacity-40 transition-colors px-1.5 py-0.5 rounded"
                        title="Download model (will auto-download on first use)"
                      >
                        {busyModels[model.modelId] ? <Loader2 size={9} className="animate-spin" /> : <Download size={9} />}
                        <span>Download</span>
                      </button>
                    )}
                    {cacheStatus[model.modelId] && (
                      <button
                        onClick={() => handleDeleteCache(model.modelId)}
                        disabled={busyModels[model.modelId]}
                        className="flex items-center gap-0.5 text-[8px] font-bold text-rose-400 hover:text-rose-300 disabled:opacity-40 transition-colors px-1.5 py-0.5 rounded"
                        title="Delete cached model files"
                      >
                        {busyModels[model.modelId] ? <Loader2 size={9} className="animate-spin" /> : <Trash2 size={9} />}
                        <span>Delete Cache</span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <p className="px-1 text-[8px] text-[var(--text-muted)] font-bold leading-relaxed uppercase tracking-tight italic opacity-60">
        Models are downloaded from HuggingFace and cached locally in your
        browser. Built-in models (🔒) cannot be modified or removed. Custom
        models must provide a valid HuggingFace repository ID with ONNX format.
      </p>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Ensures all built-in models are present in the list (handles migration
 * from older configs that might be missing newly-added built-ins).
 */
function ensureBuiltins(models: BgModelEntry[]): BgModelEntry[] {
  const result = [...models];
  for (const builtin of BUILTIN_MODELS) {
    if (!result.find((m) => m.id === builtin.id)) {
      result.unshift(builtin);
    }
  }
  return result;
}
