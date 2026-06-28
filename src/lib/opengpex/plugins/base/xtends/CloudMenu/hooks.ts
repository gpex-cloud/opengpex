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

/* eslint-disable react-hooks/set-state-in-effect */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useGpexCloud } from '@opengpex/editor/core/cloud';
import type { GpexManifest } from '@opengpex/editor/core/helpers/gpex-format';
import { useEditorState, usePluginCommands } from '@opengpex/editor/core/context';
import type { CloudMenuCommandsMap } from './commands.d';
import { hasUnsavedChanges, saveSyncRecord, loadSyncRecord } from './commands';
import type { SavePhase } from './protocols';
import type { Frame } from '@opengpex/editor/core/types';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SyncStatus = 'SYNCED' | 'LOCAL_AHEAD' | 'NEVER_SAVED' | 'OFFLINE';

/** Result from the last successful save, used for refined UI feedback */
export interface LastSaveResult {
  fileId: string;
  version: number;
  isNewFile: boolean;  // version === 1 means first upload
  savedAt: string;
}

interface ConflictState {
  existingFrame: Frame;
  manifest: GpexManifest;
  resolve: (decision: 'overwrite' | 'cancel') => void;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

/**
 * useCloudMenu: State management hook for the CloudMenu plugin.
 * Handles menu open/close, cloud auth, save/open operations, conflict resolution,
 * and sync status tracking via history-based dirty detection.
 */
export const useCloudMenu = () => {
  const { user, isSignedIn, openLogin, signOut } = useGpexCloud();
  const { state, activeFrame } = useEditorState();
  const { saveToCloudCmd, openFromCloudCmd, deleteFromCloudCmd } = usePluginCommands<CloudMenuCommandsMap>();

  // ─── Menu toggle state ──────────────────────────────────────────
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    const rafId = requestAnimationFrame(() => {
      document.addEventListener('mousedown', handleClickOutside);
    });
    return () => {
      cancelAnimationFrame(rafId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const toggleMenu = () => setIsOpen((prev) => !prev);

  // ─── Cloud operations state ─────────────────────────────────────
  const [savePhase, setSavePhase] = useState<SavePhase>('IDLE');
  const [lastSaveResult, setLastSaveResult] = useState<LastSaveResult | null>(null);
  const [showBrowser, setShowBrowser] = useState(false);
  const [conflictState, setConflictState] = useState<ConflictState | null>(null);

  // ─── Sync Status (History-based Dirty Detection) ────────────────
  // Use state.history.past.length as the dirty-check signal source.
  // Only true user edit operations (SIGNAL_COMMIT) will change history.past.length,
  // internal system operations (import, thumbnail update, re-render) will not.
  const syncStatus: SyncStatus = useMemo(() => {
    if (!isSignedIn) return 'OFFLINE';
    if (!activeFrame) return 'NEVER_SAVED';

    const record = loadSyncRecord(activeFrame.id);
    if (!record) return 'NEVER_SAVED';

    const historyPastLength = state.history?.past?.length ?? 0;
    return hasUnsavedChanges(activeFrame.id, historyPastLength) ? 'LOCAL_AHEAD' : 'SYNCED';
  }, [activeFrame, isSignedIn, state.history?.past?.length]);

  // Populate lastSaveResult from localStorage when frame changes
  useEffect(() => {
    if (!activeFrame) return;
    const record = loadSyncRecord(activeFrame.id);
    if (record && (!lastSaveResult || lastSaveResult.fileId !== activeFrame.id)) {
      setLastSaveResult({
        fileId: activeFrame.id,
        version: record.version,
        isNewFile: false,
        savedAt: record.savedAt,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFrame?.id]);

  // ─── Save to Cloud ──────────────────────────────────────────────
  const handleSaveToCloud = useCallback(async () => {
    if (!activeFrame || savePhase === 'PACKING' || savePhase === 'UPLOADING') return;

    try {
      const result = await saveToCloudCmd.execute({
        frame: activeFrame,
        onPhaseChange: setSavePhase,
      });

      // Record sync state: snapshot current history length as baseline
      const historyPastLength = state.history?.past?.length ?? 0;
      saveSyncRecord(activeFrame.id, {
        version: result.version,
        savedAt: new Date().toISOString(),
        savedHistoryLength: historyPastLength,
      });

      setLastSaveResult({
        fileId: result.fileId,
        version: result.version,
        isNewFile: result.version === 1,
        savedAt: new Date().toISOString(),
      });

      // Auto-reset phase after a short delay
      setTimeout(() => setSavePhase('IDLE'), 2500);
    } catch (err) {
      console.error('[CloudSync] Save failed:', err);
      setSavePhase('ERROR');
      setTimeout(() => setSavePhase('IDLE'), 3000);
    }
  }, [activeFrame, savePhase, saveToCloudCmd, state.history]);

  // ─── Cloud Gallery ────────────────────────────────────────────
  const handleOpenBrowser = useCallback(() => {
    setShowBrowser(true);
    setIsOpen(false); // Collapse the menu when browser opens
  }, []);

  const handleCloseBrowser = useCallback(() => {
    setShowBrowser(false);
  }, []);

  const handleSelectFile = useCallback(async (fileId: string) => {
    try {
      const result = await openFromCloudCmd.execute({
        fileId,
        onConflict: (existingFrame: Frame, manifest: GpexManifest) => {
          // Return a promise that resolves when user makes a decision
          return new Promise<'overwrite' | 'cancel'>((resolve) => {
            setConflictState({ existingFrame, manifest, resolve });
          });
        },
      });
      // Only close browser if file was actually opened (not cancelled)
      if (result) {
        setShowBrowser(false);

        // Establish SyncRecord for newly downloaded frame
        // import triggers resetHistory -> past.length = 0, so savedHistoryLength = 0
        saveSyncRecord(result.id, {
          version: 1,
          savedAt: new Date().toISOString(),
          savedHistoryLength: 0,
        });
      }
    } catch (err) {
      console.error('[CloudSync] Open failed:', err);
    }
  }, [openFromCloudCmd]);

  // ─── Conflict resolution ────────────────────────────────────────
  const handleConfirmOverwrite = useCallback(() => {
    if (conflictState) {
      conflictState.resolve('overwrite');
      setConflictState(null);
    }
  }, [conflictState]);

  const handleCancelOverwrite = useCallback(() => {
    if (conflictState) {
      conflictState.resolve('cancel');
      setConflictState(null);
    }
  }, [conflictState]);

  // ─── Delete file ────────────────────────────────────────────────
  const handleDeleteFile = useCallback(async (fileId: string) => {
    await deleteFromCloudCmd.execute({ fileId });
  }, [deleteFromCloudCmd]);

  // ─── Return ────────────────────────────────────────────────────

  return {
    // Menu state
    isOpen,
    containerRef,
    toggleMenu,
    setIsOpen,

    // Auth
    user,
    isSignedIn,
    openLogin,
    signOut,

    // Cloud operations
    savePhase,
    syncStatus,
    lastSaveResult,
    handleSaveToCloud,

    // Browser modal
    showBrowser,
    handleOpenBrowser,
    handleCloseBrowser,
    handleSelectFile,
    handleDeleteFile,

    // Conflict resolution
    conflictState,
    handleConfirmOverwrite,
    handleCancelOverwrite,
  };
};
