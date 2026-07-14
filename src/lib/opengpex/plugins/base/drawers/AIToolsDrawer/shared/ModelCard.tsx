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

/**
 * ModelCard — Shared model card component for all AI tool settings panels.
 *
 * Provides a consistent card layout across BG Remover, Upscaler, and
 * Segmentation settings with:
 *   - Model name (editable for custom, locked for builtin)
 *   - Model ID (editable for custom, display + HuggingFace link for builtin)
 *   - Metadata row (size, description, extra info)
 *   - Cache status + Download/Delete actions
 *   - Inline download progress (ModelDownloader)
 *   - Remove button for custom models
 */

import { Lock, Trash2, Download, CheckCircle2, Loader2, ExternalLink } from "lucide-react";
import { ModelDownloader } from "./download/ModelDownloader";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ModelCardModel {
  id: string;
  name: string;
  modelId: string;
  size: string;
  description: string;
  builtin: boolean;
  /** Extra metadata badge (e.g. "4× scale") */
  badge?: string;
}

export interface ModelCardProps {
  model: ModelCardModel;
  /** Is this model currently cached locally? */
  isCached: boolean;
  /** Is an operation in progress for this model? */
  isBusy: boolean;
  /** Is any download currently active (blocks new downloads)? */
  isAnyDownloading: boolean;
  /** Download progress state (if this model is being downloaded) */
  downloadProgress?: {
    progress: number;
    loadedBytes: number;
    totalBytes: number;
    speedBps: number;
    currentFile: string | null;
  };
  /** Callbacks */
  onNameChange?: (name: string) => void;
  onModelIdChange?: (modelId: string) => void;
  onDownload: () => void;
  onDelete: () => void;
  onRemove?: () => void;
  onCancelDownload?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ModelCard({
  model,
  isCached,
  isBusy,
  isAnyDownloading,
  downloadProgress,
  onNameChange,
  onModelIdChange,
  onDownload,
  onDelete,
  onRemove,
  onCancelDownload,
}: ModelCardProps) {
  const hfUrl = model.modelId ? `https://huggingface.co/${model.modelId}` : null;

  return (
    <div className="flex flex-col gap-2 rounded-lg p-2.5 border bg-[var(--bg-stage)] border-[var(--border-subtle)]">
      {/* Row 1: Name + actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {model.builtin && (
            <Lock size={9} className="text-[var(--text-muted)] shrink-0" />
          )}
          {model.builtin ? (
            <span className="text-[11px] font-semibold text-[var(--text-main)] truncate">
              {model.name}
            </span>
          ) : (
            <input
              type="text"
              value={model.name}
              onChange={(e) => onNameChange?.(e.target.value)}
              className="bg-transparent border-none text-[11px] font-semibold text-[var(--text-main)] focus:outline-none flex-1 min-w-0 focus:ring-1 focus:ring-[var(--border-subtle)] rounded px-1 -ml-1"
            />
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* HuggingFace link */}
          {hfUrl && (
            <a
              href={hfUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors p-0.5"
              title={`View on HuggingFace: ${model.modelId}`}
            >
              <ExternalLink size={10} />
            </a>
          )}
          {/* Remove button (custom models only) */}
          {!model.builtin && onRemove && (
            <button
              onClick={onRemove}
              className="text-[var(--text-muted)] hover:text-rose-500 transition-colors p-0.5"
              title="Remove model"
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Row 2: Model ID */}
      <div className="flex flex-col gap-0.5">
        {model.builtin ? (
          <span className="text-[10px] text-[var(--text-secondary)] font-mono truncate">
            {model.modelId}
          </span>
        ) : (
          <input
            type="text"
            value={model.modelId}
            onChange={(e) => onModelIdChange?.(e.target.value)}
            placeholder="owner/model-name"
            className="w-full bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-md px-2 py-1 text-[10px] text-[var(--text-main)] font-mono focus:outline-none focus:border-[var(--text-secondary)] transition-colors placeholder:text-[var(--text-muted)]"
          />
        )}
      </div>

      {/* Row 3: Meta + Cache actions */}
      <div className="flex items-center justify-between">
        <span className="text-[9px] text-[var(--text-muted)]">
          {model.size}
          {model.badge ? ` · ${model.badge}` : ''}
          {model.description ? ` · ${model.description}` : ''}
        </span>
        {model.modelId && (
          <div className="flex items-center gap-1.5">
            {isCached ? (
              <>
                <span className="text-emerald-400 flex items-center gap-0.5 text-[9px]">
                  <CheckCircle2 size={9} /> Cached
                </span>
                <button
                  onClick={onDelete}
                  disabled={isBusy}
                  className="px-1.5 py-1 -my-0.5 rounded text-[9px] font-semibold text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 disabled:opacity-40 transition-colors"
                  title="Delete cached model files"
                >
                  {isBusy ? <Loader2 size={9} className="animate-spin" /> : "Delete"}
                </button>
              </>
            ) : (
              <button
                onClick={onDownload}
                disabled={isBusy || isAnyDownloading}
                className="flex items-center gap-0.5 px-1.5 py-1 -my-0.5 rounded text-[9px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-main)] hover:bg-white/5 disabled:opacity-40 transition-colors"
                title="Download model"
              >
                {isBusy ? <Loader2 size={9} className="animate-spin" /> : <Download size={9} />}
                <span>Download</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* ─── Download Progress (inline) ─────────── */}
      {downloadProgress && (
        <ModelDownloader
          progress={downloadProgress.progress}
          loadedBytes={downloadProgress.loadedBytes}
          totalBytes={downloadProgress.totalBytes}
          speedBps={downloadProgress.speedBps}
          currentFile={downloadProgress.currentFile}
          onCancel={onCancelDownload}
        />
      )}
    </div>
  );
}
