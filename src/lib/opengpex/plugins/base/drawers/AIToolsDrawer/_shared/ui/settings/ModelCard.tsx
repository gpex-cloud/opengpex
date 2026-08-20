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
 *   - Inline download progress (DownloadPanel)
 *   - Remove button for custom models
 */

import { Lock, Trash2, Download, Loader2, ExternalLink, HardDriveDownload, HardDriveUpload } from "lucide-react";
import Tooltip from "@opengpex/editor/widgets/Tooltip";
import { DownloadPanel } from "../DownloadPanel";

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
  /** Export model to local zip file (shown when cached) */
  onExport?: () => void;
  /** Import model from local zip file (shown when not cached) */
  onImport?: () => void;
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
  onExport,
  onImport,
}: ModelCardProps) {
  const hfUrl = model.modelId ? `https://huggingface.co/${model.modelId}` : null;

  return (
    <div className="flex flex-col gap-2 rounded-lg px-2.5 py-2 border bg-[var(--bg-stage)] border-[var(--border-subtle)]">
      {/* Row 1: Name + cached badge + actions */}
      <div className="flex items-center gap-1.5 pb-1 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {model.builtin && (
            <Lock size={10} className="text-[var(--text-muted)] shrink-0" />
          )}
          {model.builtin ? (
            <span className="text-xs font-semibold text-[var(--text-main)] truncate">
              {model.name}
            </span>
          ) : (
            <input
              type="text"
              value={model.name}
              onChange={(e) => onNameChange?.(e.target.value)}
              className="bg-transparent border-none text-xs font-semibold text-[var(--text-main)] focus:outline-none flex-1 min-w-0 focus:ring-1 focus:ring-[var(--border-subtle)] rounded px-1 -ml-1"
            />
          )}
          {isCached && (
            <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider text-emerald-400 bg-emerald-400/10 border border-emerald-400/30 px-1.5 py-0.5 rounded-full">
              Cached
            </span>
          )}
        </div>
        {hfUrl && (
          <a
            href={hfUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={model.modelId}
            className="text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors shrink-0"
          >
            <ExternalLink size={11} />
          </a>
        )}
        {!model.builtin && onRemove && (
          <button
            onClick={onRemove}
            title="Remove model"
            className="text-[var(--text-muted)] hover:text-rose-500 transition-colors shrink-0"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>

      {/* Row 2: Model ID + Cache actions */}
      <div className="flex items-center gap-2">
        {model.builtin ? (
          <span className="text-[11px] text-[var(--text-secondary)] font-mono truncate flex-1 min-w-0">
            {model.modelId}
          </span>
        ) : (
          <input
            type="text"
            value={model.modelId}
            onChange={(e) => onModelIdChange?.(e.target.value)}
            placeholder="owner/model-name"
            className="flex-1 min-w-0 bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-md px-2 py-1 text-[11px] text-[var(--text-main)] font-mono focus:outline-none focus:border-[var(--text-secondary)] transition-colors placeholder:text-[var(--text-muted)]"
          />
        )}
        {model.modelId && (
          <div className="flex items-center gap-1.5 shrink-0">
            <Tooltip content="Download model" position="bottom" align="end">
              <button
                onClick={onDownload}
                disabled={isBusy || isAnyDownloading || isCached}
                className="flex items-center gap-0.5 px-1.5 py-1 -my-0.5 rounded text-[10px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-main)] hover:bg-white/5 disabled:opacity-40 transition-colors"
              >
                {isBusy && !isCached ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
                <span>Download</span>
              </button>
            </Tooltip>
            {onImport && (
              <Tooltip content="Import model from local file" position="bottom" align="end">
                <button
                  onClick={onImport}
                  disabled={isBusy || isAnyDownloading || isCached}
                  className="flex items-center gap-0.5 px-1.5 py-1 -my-0.5 rounded text-[10px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-main)] hover:bg-white/5 disabled:opacity-40 transition-colors"
                >
                  <HardDriveUpload size={10} />
                  <span>Use Local</span>
                </button>
              </Tooltip>
            )}
            {isCached && onExport && (
              <Tooltip content="Export model to local file" position="bottom" align="end">
                <button
                  onClick={onExport}
                  disabled={isBusy}
                  className="flex items-center gap-0.5 px-1.5 py-1 -my-0.5 rounded text-[10px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-main)] hover:bg-white/5 disabled:opacity-40 transition-colors"
                >
                  <HardDriveDownload size={10} />
                  <span>Export</span>
                </button>
              </Tooltip>
            )}
            {isCached && (
              <Tooltip content="Delete cached files" position="bottom" align="end">
                <button
                  onClick={onDelete}
                  disabled={isBusy}
                  className="flex items-center gap-0.5 px-1.5 py-1 -my-0.5 rounded text-[10px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-main)] hover:bg-white/5 disabled:opacity-40 transition-colors"
                >
                  {isBusy ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                  <span>Delete</span>
                </button>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      {/* Row 3: Meta info */}
      <span className="text-[10px] text-[var(--text-muted)]">
        {model.size}
        {model.badge ? ` · ${model.badge}` : ''}
        {model.description ? ` · ${model.description}` : ''}
      </span>

      {/* ─── Download Progress (inline) ─────────── */}
      {downloadProgress && (
        <DownloadPanel
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
