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

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Trash2, FolderOpen, FileImage, Loader2, Cloud, LayoutGrid, List, Layers, Image as ImageIcon, Share2, Link2, X, Check } from 'lucide-react';
import { PopupPanel } from '@opengpex/editor/widgets/PopupPanel';
import FancyConfirm from '@opengpex/editor/widgets/FancyConfirm';
import EditorPortal from '@opengpex/editor/widgets/Portal';
import { gpexStorage, type GpexFileItem } from '@opengpex/editor/core/cloud';

// ─── Props ───────────────────────────────────────────────────────────────────

interface CloudBrowserProps {
  onSelect: (fileId: string) => Promise<void>;
  onDelete: (fileId: string) => Promise<void>;
  onClose: () => void;
}

// ─── View Mode ───────────────────────────────────────────────────────────────

type ViewMode = 'grid' | 'list';

// ─── Utilities ───────────────────────────────────────────────────────────────

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  } catch { return iso; }
};

const formatDateGroup = (iso: string) => {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
};

const formatDimensions = (w?: number, h?: number) => {
  if (!w || !h) return null;
  return `${w}×${h}`;
};

// ─── Timeline Grouping ───────────────────────────────────────────────────────

interface DateGroup {
  label: string;
  files: GpexFileItem[];
}

function groupByDate(files: GpexFileItem[]): DateGroup[] {
  const groups: Map<string, GpexFileItem[]> = new Map();
  for (const file of files) {
    const label = formatDateGroup(file.updatedAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(file);
  }
  return Array.from(groups.entries()).map(([label, groupFiles]) => ({ label, files: groupFiles }));
}

// ─── Thumbnail Component ─────────────────────────────────────────────────────

function Thumbnail({ previewB64, size = 'sm' }: { previewB64: string | null; size?: 'sm' | 'lg' }) {
  const sizeClasses = {
    sm: 'w-10 h-10 rounded-lg',
    lg: 'w-full aspect-[3/2] rounded-lg',
  };

  if (previewB64) {
    return (
      <div className={`${sizeClasses[size]} overflow-hidden bg-[var(--bg-stage)] border border-[var(--border-subtle)] shrink-0`}>
        <img
          src={previewB64}
          alt="Preview"
          className="w-full h-full object-cover"
          draggable={false}
        />
      </div>
    );
  }

  return (
    <div className={`${sizeClasses[size]} flex items-center justify-center bg-[var(--bg-stage)] border border-[var(--border-subtle)] shrink-0`}>
      <FileImage size={size === 'lg' ? 20 : 14} className="text-[var(--text-muted)] opacity-40" />
    </div>
  );
}

// ─── Version Badge ───────────────────────────────────────────────────────────

function VersionBadge({ version }: { version: number }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-indigo-500/15 text-[8px] font-black text-indigo-400 uppercase tracking-wide leading-none">
      v{version}
    </span>
  );
}

// ─── Date Section Header ─────────────────────────────────────────────────────

function DateHeader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 px-1 pt-3 pb-1.5 first:pt-0">
      <div className="w-1.5 h-1.5 rounded-full bg-indigo-500/60" />
      <span className="text-[9px] font-black uppercase tracking-widest text-[var(--text-muted)]">
        {label}
      </span>
      <div className="flex-1 h-px bg-[var(--border-subtle)]" />
    </div>
  );
}

// ─── Share Toast ─────────────────────────────────────────────────────────────

function ShareToast({ shareUrl, onClose }: { shareUrl: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* noop */ }
  };

  return (
    <div className="absolute bottom-3 left-3 right-3 z-50 flex items-center gap-2 p-3 rounded-xl bg-[var(--bg-panel)] border border-emerald-500/40 shadow-lg shadow-emerald-500/10 animate-in slide-in-from-bottom-2">
      <Link2 size={14} className="text-emerald-400 shrink-0" />
      <input
        type="text"
        value={shareUrl}
        readOnly
        className="flex-1 text-[10px] font-mono text-[var(--text-main)] bg-transparent border-0 outline-none truncate"
        onFocus={(e) => e.target.select()}
      />
      <button
        onClick={handleCopy}
        className="flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 transition-colors cursor-pointer border-0 outline-none shrink-0"
        title="Copy link"
      >
        {copied
          ? <Check size={12} className="text-emerald-400" />
          : <Link2 size={12} className="text-emerald-400" />
        }
      </button>
      <button
        onClick={onClose}
        className="flex items-center justify-center w-6 h-6 rounded-lg hover:bg-[var(--bg-stage)] transition-colors cursor-pointer border-0 outline-none shrink-0"
        title="Dismiss"
      >
        <X size={11} className="text-[var(--text-muted)]" />
      </button>
    </div>
  );
}

// ─── Card Item (Grid View) ───────────────────────────────────────────────────

function CardItem({
  file,
  onSelect,
  onDelete,
  onShare,
  isDeleting,
  isOpening,
  isSharing,
}: {
  file: GpexFileItem;
  onSelect: () => void;
  onDelete: () => void;
  onShare: () => void;
  isDeleting: boolean;
  isOpening: boolean;
  isSharing: boolean;
}) {
  const dims = formatDimensions(file.manifest?.canvasWidth, file.manifest?.canvasHeight);
  const layers = file.manifest?.layerCount;

  return (
    <div className="group flex flex-col rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)] hover:border-indigo-500/30 hover:shadow-md hover:shadow-indigo-500/5 transition-all duration-200 overflow-hidden">
      {/* Thumbnail Area */}
      <Thumbnail previewB64={file.previewB64} size="lg" />

      {/* Info Area */}
      <div className="flex flex-col px-2 py-1.5 gap-1 flex-grow">
        {/* Title + Version */}
        <div className="flex items-center gap-1 min-w-0">
          <span className="flex-1 text-[10px] font-bold text-[var(--text-main)] truncate leading-tight">
            {file.manifest?.frameName || file.fileLocalId}
          </span>
          <VersionBadge version={file.version} />
        </div>

        {/* Metadata row */}
        <div className="flex items-center gap-1.5 text-[8px] text-[var(--text-muted)] font-medium">
          {dims && (
            <span className="flex items-center gap-0.5">
              <ImageIcon size={7} className="opacity-60" />
              {dims}
            </span>
          )}
          {layers != null && (
            <span className="flex items-center gap-0.5">
              <Layers size={7} className="opacity-60" />
              {layers}
            </span>
          )}
          <span className="ml-auto">{formatSize(file.fileSize)}</span>
        </div>

        {/* Date */}
        <div className="text-[7px] text-[var(--text-muted)] opacity-70 font-medium">
          {formatDate(file.updatedAt)}
        </div>
      </div>

      {/* Bottom Action Bar */}
      <div className="px-2 py-1.5 border-t border-[var(--border-subtle)]/30 bg-[var(--bg-stage)]/40 flex items-center justify-end gap-1 shrink-0">
        <button
          onClick={onSelect}
          disabled={isOpening}
          className="flex items-center justify-center w-6 h-6 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-panel)] hover:border-indigo-500/50 hover:text-indigo-400 text-[var(--text-muted)] transition-all cursor-pointer border-0 outline-none disabled:opacity-60"
          title="Open"
        >
          {isOpening
            ? <Loader2 size={11} className="animate-spin" />
            : <FolderOpen size={11} />
          }
        </button>
        <button
          onClick={onShare}
          disabled={isSharing}
          className="flex items-center justify-center w-6 h-6 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-panel)] hover:border-emerald-500/50 hover:text-emerald-400 text-[var(--text-muted)] transition-all cursor-pointer border-0 outline-none disabled:opacity-60"
          title="Share"
        >
          {isSharing
            ? <Loader2 size={11} className="animate-spin" />
            : <Share2 size={11} />
          }
        </button>
        <button
          onClick={onDelete}
          disabled={isDeleting}
          className="flex items-center justify-center w-6 h-6 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-panel)] hover:border-red-500/50 hover:text-red-400 text-[var(--text-muted)] transition-all cursor-pointer border-0 outline-none disabled:opacity-40"
          title="Delete"
        >
          {isDeleting
            ? <Loader2 size={11} className="animate-spin" />
            : <Trash2 size={11} />
          }
        </button>
      </div>
    </div>
  );
}

// ─── List Item (List View) ───────────────────────────────────────────────────

function ListItem({
  file,
  onSelect,
  onDelete,
  isDeleting,
  isOpening,
}: {
  file: GpexFileItem;
  onSelect: () => void;
  onDelete: () => void;
  isDeleting: boolean;
  isOpening: boolean;
}) {
  const dims = formatDimensions(file.manifest?.canvasWidth, file.manifest?.canvasHeight);
  const layers = file.manifest?.layerCount;

  return (
    <div className="group flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-[var(--bg-stage)] transition-colors">
      {/* Thumbnail */}
      <Thumbnail previewB64={file.previewB64} size="sm" />

      {/* Info */}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[11px] font-bold text-[var(--text-main)] truncate">
            {file.manifest?.frameName || file.fileLocalId}
          </span>
          <VersionBadge version={file.version} />
        </div>
        <div className="flex items-center gap-2 text-[9px] text-[var(--text-muted)] font-medium">
          {dims && (
            <span className="flex items-center gap-0.5">
              <ImageIcon size={8} className="opacity-60" />
              {dims}
            </span>
          )}
          {layers != null && (
            <span className="flex items-center gap-0.5">
              <Layers size={8} className="opacity-60" />
              {layers}
            </span>
          )}
          <span>·</span>
          <span>{formatSize(file.fileSize)}</span>
          <span>·</span>
          <span>{formatDate(file.updatedAt)}</span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onSelect}
          disabled={isOpening}
          className="flex items-center justify-center w-7 h-7 rounded-lg hover:bg-indigo-500/20 transition-colors cursor-pointer border-0 outline-none disabled:opacity-60"
          title="Open"
        >
          {isOpening
            ? <Loader2 size={13} className="animate-spin text-indigo-400" />
            : <FolderOpen size={13} className="text-indigo-400" />
          }
        </button>
        <button
          onClick={onDelete}
          disabled={isDeleting}
          className="flex items-center justify-center w-7 h-7 rounded-lg hover:bg-red-500/20 transition-colors cursor-pointer border-0 outline-none disabled:opacity-40"
          title="Delete"
        >
          {isDeleting
            ? <Loader2 size={13} className="animate-spin text-red-400" />
            : <Trash2 size={13} className="text-red-400" />
          }
        </button>
      </div>
    </div>
  );
}

// ─── View Mode Toggle ────────────────────────────────────────────────────────

function ViewModeToggle({ viewMode, onChange }: { viewMode: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="flex items-center gap-0.5">
      <button
        onClick={() => onChange('grid')}
        className={`flex items-center justify-center w-6 h-6 rounded-md transition-all cursor-pointer border-0 outline-none ${
          viewMode === 'grid'
            ? 'bg-indigo-500/20 text-indigo-400'
            : 'text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-stage)]'
        }`}
        title="Card view"
      >
        <LayoutGrid size={12} />
      </button>
      <button
        onClick={() => onChange('list')}
        className={`flex items-center justify-center w-6 h-6 rounded-md transition-all cursor-pointer border-0 outline-none ${
          viewMode === 'list'
            ? 'bg-indigo-500/20 text-indigo-400'
            : 'text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-stage)]'
        }`}
        title="List view"
      >
        <List size={12} />
      </button>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * CloudBrowser: PopupPanel overlay for browsing and managing cloud-stored .gpex files.
 * Supports card and list view modes with chronological date grouping (timeline).
 */
export function CloudBrowser({ onSelect, onDelete, onClose }: CloudBrowserProps) {
  const [files, setFiles] = useState<GpexFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try { return (localStorage.getItem('gpex_browser_view') as ViewMode) || 'grid'; }
    catch { return 'grid'; }
  });

  // Group files chronologically
  const dateGroups = useMemo(() => groupByDate(files), [files]);

  // Persist view mode choice
  useEffect(() => {
    try { localStorage.setItem('gpex_browser_view', viewMode); } catch { /* noop */ }
  }, [viewMode]);

  // Fetch file list on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const result = await gpexStorage.list();
        if (!cancelled) {
          setFiles(result || []);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError('Failed to load files from cloud.');
          console.error('[CloudBrowser] List error:', err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleOpen = useCallback(async (fileId: string) => {
    setOpeningId(fileId);
    try {
      await onSelect(fileId);
    } catch (err) {
      console.error('[CloudBrowser] Open failed:', err);
    } finally {
      setOpeningId(null);
    }
  }, [onSelect]);

  // Request delete (shows confirmation)
  const requestDelete = useCallback((fileId: string) => {
    setPendingDeleteId(fileId);
  }, []);

  // Confirmed delete
  const confirmDelete = useCallback(async () => {
    const fileId = pendingDeleteId;
    setPendingDeleteId(null);
    if (!fileId) return;

    setDeletingId(fileId);
    try {
      await onDelete(fileId);
      setFiles(prev => prev.filter(f => f.fileId !== fileId));
    } catch (err) {
      console.error('[CloudBrowser] Delete failed:', err);
    } finally {
      setDeletingId(null);
    }
  }, [pendingDeleteId, onDelete]);

  // Cancel delete
  const cancelDelete = useCallback(() => {
    setPendingDeleteId(null);
  }, []);

  // Share file — idempotent: re-clicking just copies the same URL again
  const handleShare = useCallback(async (fileId: string) => {
    setSharingId(fileId);
    try {
      const result = await gpexStorage.share(fileId);
      setShareUrl(result.shareUrl);
      // Auto-copy to clipboard
      try { await navigator.clipboard.writeText(result.shareUrl); } catch { /* noop */ }
    } catch (err) {
      console.error('[CloudBrowser] Share failed:', err);
    } finally {
      setSharingId(null);
    }
  }, []);

  const dismissShare = useCallback(() => {
    setShareUrl(null);
  }, []);

  return (
    <PopupPanel
      isVisible={true}
      onClose={onClose}
      title="Cloud Files"
      subTitle={files.length > 0 ? `${files.length} file${files.length !== 1 ? 's' : ''}` : 'Browse & Manage'}
      icon={<Cloud size={16} />}
      size="lg"
      position="CT"
      closeOnOutsideClick={false}
      headerRight={
        !loading && !error && files.length > 0
          ? <ViewModeToggle viewMode={viewMode} onChange={setViewMode} />
          : undefined
      }
    >
      <div className="flex-1 flex flex-col overflow-y-auto min-h-0 custom-scrollbar">
        {loading && (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 size={20} className="animate-spin text-[var(--text-muted)]" />
          </div>
        )}

        {error && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-[11px] text-red-400 font-medium">{error}</p>
          </div>
        )}

        {!loading && !error && files.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center gap-2">
            <FileImage size={28} className="text-[var(--text-muted)] opacity-40" />
            <p className="text-[11px] text-[var(--text-muted)] font-medium">No files saved yet</p>
          </div>
        )}

        {/* Grid View — with date grouping */}
        {!loading && !error && files.length > 0 && viewMode === 'grid' && (
          <div className="flex flex-col p-3 gap-1">
            {dateGroups.map((group) => (
              <div key={group.label}>
                <DateHeader label={group.label} />
                <div className="grid grid-cols-4 gap-2">
                  {group.files.map((file) => (
                    <CardItem
                      key={file.fileId}
                      file={file}
                      onSelect={() => handleOpen(file.fileId)}
                      onDelete={() => requestDelete(file.fileId)}
                      onShare={() => handleShare(file.fileId)}
                      isDeleting={deletingId === file.fileId}
                      isOpening={openingId === file.fileId}
                      isSharing={sharingId === file.fileId}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* List View — with date grouping */}
        {!loading && !error && files.length > 0 && viewMode === 'list' && (
          <div className="flex flex-col p-2 gap-0">
            {dateGroups.map((group) => (
              <div key={group.label}>
                <DateHeader label={group.label} />
                <div className="flex flex-col gap-0.5">
                  {group.files.map((file) => (
                    <ListItem
                      key={file.fileId}
                      file={file}
                      onSelect={() => handleOpen(file.fileId)}
                      onDelete={() => requestDelete(file.fileId)}
                      isDeleting={deletingId === file.fileId}
                      isOpening={openingId === file.fileId}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Share URL Toast */}
      {shareUrl && <ShareToast shareUrl={shareUrl} onClose={dismissShare} />}

      {/* Delete Confirmation */}
      <EditorPortal>
        <FancyConfirm
          isVisible={!!pendingDeleteId}
          title="Delete File?"
          message="This file will be permanently removed from cloud storage. This action cannot be undone."
          type="danger"
          variant="square"
          mode="confirm"
          confirmText="Delete"
          cancelText="Cancel"
          onConfirm={confirmDelete}
          onCancel={cancelDelete}
        />
      </EditorPortal>
    </PopupPanel>
  );
}


