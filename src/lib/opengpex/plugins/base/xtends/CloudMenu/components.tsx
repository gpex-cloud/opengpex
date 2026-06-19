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

import { useState, useEffect, useCallback } from "react";
import {
  LogOut,
  LogIn,
  Upload,
  FolderOpen,
  Loader2,
  Check,
  AlertCircle,
  CloudOff,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import { GpexCloudProvider, gpexStorage } from "@opengpex/editor/core/cloud";
import { PremiumCloudIcon } from "@opengpex/editor/icons";
import { useCloudMenu, type SyncStatus, type LastSaveResult } from "./hooks";
import { CloudBrowser } from "./CloudBrowser";
import FancyConfirm from "@opengpex/editor/widgets/FancyConfirm";
import EditorPortal from "@opengpex/editor/widgets/Portal";
import { DEFAULT_CLOUD_URL, type SavePhase } from "./protocols";
import { API_AUTH_SSO_CODE } from "../../../../core/cloud/protocol";
// IMPORTANT: Must use relative path to ensure importing the exact same in-memory token-store instance
// as other auth files. Do NOT replace with alias path (like @opengpex/editor/...) to prevent bundle duplication.
import { authFetch } from "../../../../core/cloud/auth/http-client";
import { getRefreshToken } from "../../../../core/cloud/auth/token-store";

// ─── Sync Status Indicator ───────────────────────────────────────────────────

const SyncStatusIndicator = ({
  syncStatus,
  lastSaveResult,
}: {
  syncStatus: SyncStatus;
  lastSaveResult: LastSaveResult | null;
}) => {
  switch (syncStatus) {
    case "SYNCED":
      return (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-emerald-500/15 border border-emerald-600/30">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.6)]" />
          <span className="text-[9px] font-bold text-emerald-600">
            Synced{lastSaveResult ? ` · v${lastSaveResult.version}` : ""}
          </span>
        </div>
      );
    case "LOCAL_AHEAD":
      return (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-500/15 border border-amber-600/30">
          <div className="w-1.5 h-1.5 rounded-full bg-amber-500 shadow-[0_0_4px_rgba(245,158,11,0.6)]" />
          <span className="text-[9px] font-bold text-amber-600">
            Unsaved changes
          </span>
        </div>
      );
    case "NEVER_SAVED":
      return (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
          <div className="w-1.5 h-1.5 rounded-full bg-[var(--text-muted)] opacity-50" />
          <span className="text-[9px] font-bold text-[var(--text-muted)]">
            Local only
          </span>
        </div>
      );
    case "OFFLINE":
      return (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
          <CloudOff size={9} className="text-[var(--text-muted)] opacity-50" />
          <span className="text-[9px] font-bold text-[var(--text-muted)]">
            Offline
          </span>
        </div>
      );
    default:
      return null;
  }
};

// ─── Premium Cloud Icon ──────────────────────────────────────────────────────

const PremiumCloud = ({
  isOpen,
  isActive,
}: {
  isOpen: boolean;
  isActive: boolean;
}) => (
  <PremiumCloudIcon
    className={`w-5 h-5 transition-all duration-300 ${
      !isActive
        ? "grayscale opacity-50 hover:opacity-70"
        : isOpen
          ? "scale-110 drop-shadow-[0_2px_8px_rgba(0,242,254,0.4)]"
          : "hover:scale-105 opacity-85 hover:opacity-100"
    }`}
  />
);

// ─── Save Phase Indicators ───────────────────────────────────────────────────

const SavePhaseIcon = ({ phase }: { phase: SavePhase }) => {
  switch (phase) {
    case "PACKING":
    case "UPLOADING":
      return <Loader2 size={12} className="animate-spin text-indigo-400" />;
    case "DONE":
      return <Check size={12} className="text-emerald-400" />;
    case "ERROR":
      return <AlertCircle size={12} className="text-red-400" />;
    default:
      return null;
  }
};

const SavePhaseLabel = ({
  phase,
  lastSaveResult,
}: {
  phase: SavePhase;
  lastSaveResult: LastSaveResult | null;
}) => {
  switch (phase) {
    case "PACKING":
      return (
        <span className="text-[9px] text-indigo-400 font-bold">Packing…</span>
      );
    case "UPLOADING":
      return (
        <span className="text-[9px] text-indigo-400 font-bold">
          {lastSaveResult?.isNewFile === false ? "Updating…" : "Uploading…"}
        </span>
      );
    case "DONE":
      if (lastSaveResult) {
        return (
          <span className="text-[9px] text-emerald-400 font-bold">
            {lastSaveResult.isNewFile
              ? "✨ Saved!"
              : `Updated to v${lastSaveResult.version}`}
          </span>
        );
      }
      return (
        <span className="text-[9px] text-emerald-400 font-bold">Saved!</span>
      );
    case "ERROR":
      return <span className="text-[9px] text-red-400 font-bold">Failed</span>;
    default:
      return null;
  }
};

// ─── Save Button Label ───────────────────────────────────────────────────────

const SaveButtonLabel = ({ isSaving }: { isSaving: boolean }) => {
  if (isSaving) return "Syncing…";
  return "Sync to Cloud";
};

// ─── Save Button Icon ────────────────────────────────────────────────────────

const SaveButtonIcon = ({
  isSaving,
  syncStatus,
}: {
  isSaving: boolean;
  syncStatus: SyncStatus;
}) => {
  if (isSaving) return <Loader2 size={14} className="animate-spin" />;
  if (syncStatus === "LOCAL_AHEAD") return <RefreshCw size={14} />;
  return <Upload size={14} />;
};

/**
 * Style generator (migrated from original CloudMenu.styles.ts)
 */
const getStyles = () => ({
  trigger: {
    className: `
      flex items-center justify-center shrink-0 transition-all duration-300
      outline-none focus:outline-none focus:ring-0 select-none cursor-pointer
      w-[34px] h-[34px] rounded-xl hover:bg-[var(--bg-stage)] active:scale-90
    `,
  },
  divider: {
    className:
      "h-px self-stretch bg-[var(--border-subtle)] mx-2 my-1 shrink-0 block",
  },
  menuItem: {
    button: `
      group relative flex items-center w-full h-[34px] px-3 gap-3 rounded-xl
      bg-transparent hover:bg-[var(--bg-stage)] border-none
      transition-all duration-200 cursor-pointer text-left outline-none
    `,
    icon: "w-4 h-4 flex items-center justify-center shrink-0 text-[var(--text-muted)] group-hover:text-[var(--text-main)] transition-colors",
    label:
      "flex-1 text-[12px] font-medium text-[var(--text-main)] normal-case whitespace-nowrap",
    badge: "flex items-center gap-1",
  },
  menuItemDestructive: {
    button: `
      group relative flex items-center w-full h-[34px] px-3 gap-3 rounded-xl
      bg-transparent hover:bg-red-500/10 dark:hover:bg-red-500/15 border-none
      transition-all duration-200 cursor-pointer text-left outline-none
    `,
    icon: "w-4 h-4 flex items-center justify-center shrink-0 text-red-500/75 group-hover:text-red-500 transition-colors",
    label:
      "flex-1 text-[12px] font-medium text-red-500/75 group-hover:text-red-500 normal-case whitespace-nowrap",
  },
  infoWidget: {
    container:
      "flex flex-col p-3 my-1 gap-2 bg-[var(--bg-stage)] rounded-xl border border-[var(--border-subtle)] shadow-inner",
    storageContainer: "flex flex-col gap-1.5",
    storageHeader: "flex items-center justify-between text-[9px]",
    storageLabel:
      "font-black text-[var(--text-muted)] uppercase tracking-widest",
    storageValue: "font-black text-[#007A80] dark:text-[#00F2FE]",
    track:
      "h-1 w-full bg-[var(--bg-panel)] rounded-full overflow-hidden border border-[var(--border-subtle)]",
    bar: "h-full bg-gradient-to-r from-[#00F2FE] to-[#4FACFE] rounded-full transition-all duration-500",
  },
});

/**
 * CloudMenuComponent: Outer container responsible for injecting GpexCloudProvider (based on pluginConfig.cloudUrl)
 * Provider is limited to this plugin subtree, not polluting global layout.
 */
export function CloudMenuComponent() {
  return (
    <GpexCloudProvider apiBaseUrl={DEFAULT_CLOUD_URL}>
      <CloudMenuInner />
    </GpexCloudProvider>
  );
}

/**
 * CloudMenuInner: True UI logic (inside GpexCloudProvider, safe to use useGpexCloud)
 */
function CloudMenuInner() {
  const {
    isOpen,
    containerRef,
    toggleMenu,
    setIsOpen,
    user,
    isSignedIn,
    openLogin,
    signOut,
    // Cloud operations
    savePhase,
    syncStatus,
    lastSaveResult,
    handleSaveToCloud,
    // Browser
    showBrowser,
    handleOpenBrowser,
    handleCloseBrowser,
    handleSelectFile,
    handleDeleteFile,
    // Conflict
    conflictState,
    handleConfirmOverwrite,
    handleCancelOverwrite,
  } = useCloudMenu();

  const styles = getStyles();
  const isSaving = savePhase === "PACKING" || savePhase === "UPLOADING";

  /**
   * Navigate to GPEX Cloud with SSO code for automatic login sync.
   * If signed in, generates a one-time code via /api/auth/sso-code,
   * then opens gpex-cloud with ?sso_code=xxx for seamless auth handoff.
   * Falls back to direct navigation if code generation fails.
   */
  const handleGoToCloud = useCallback(async () => {
    if (!isSignedIn) {
      window.open(DEFAULT_CLOUD_URL, "_blank", "noopener,noreferrer");
      return;
    }

    const refresh = getRefreshToken();
    if (!refresh) {
      window.open(DEFAULT_CLOUD_URL, "_blank", "noopener,noreferrer");
      return;
    }

    try {
      const res = await authFetch(API_AUTH_SSO_CODE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: refresh }),
      });

      if (res.ok) {
        const { code } = (await res.json()) as { code: string };
        window.open(`${DEFAULT_CLOUD_URL}?sso_code=${code}`, "_blank", "noopener,noreferrer");
      } else {
        // Fallback: open without SSO
        window.open(DEFAULT_CLOUD_URL, "_blank", "noopener,noreferrer");
      }
    } catch {
      // Fallback: open without SSO
      window.open(DEFAULT_CLOUD_URL, "_blank", "noopener,noreferrer");
    }
  }, [isSignedIn]);

  // Fetch real quota from cloud
  const [quota, setQuota] = useState<{
    usedBytes: number;
    totalBytes: number;
    fileCount: number;
  } | null>(null);
  const [prevIsSignedIn, setPrevIsSignedIn] = useState(isSignedIn);

  if (isSignedIn !== prevIsSignedIn) {
    setPrevIsSignedIn(isSignedIn);
    if (!isSignedIn) {
      setQuota(null);
    }
  }

  useEffect(() => {
    if (isSignedIn) {
      gpexStorage
        .getQuota()
        .then(setQuota)
        .catch(() => setQuota(null));
    }
  }, [isSignedIn, savePhase]); // re-fetch after save completes

  const storagePercent = quota
    ? Math.round((quota.usedBytes / quota.totalBytes) * 100)
    : 0;
  const formatBytes = (b: number) =>
    b < 1024 * 1024
      ? `${(b / 1024).toFixed(0)} KB`
      : `${(b / (1024 * 1024)).toFixed(1)} MB`;

  // Collapsed state: show only a single 34x34 button
  if (!isOpen) {
    return (
      <>
        <div
          ref={containerRef}
          className="relative flex items-center justify-center w-[34px] h-[34px] bg-[var(--bg-panel)]/90 backdrop-blur-3xl border border-[var(--border-subtle)] shadow-[0_8px_32px_0_rgba(0,0,0,0.12)] rounded-xl"
        >
          <button
            className={styles.trigger.className}
            onClick={toggleMenu}
            title="Account"
          >
            <PremiumCloud isOpen={false} isActive={isSignedIn} />
          </button>
        </div>

        {/* Portal-level modals */}
        {showBrowser && (
          <CloudBrowser
            onSelect={handleSelectFile}
            onDelete={handleDeleteFile}
            onClose={handleCloseBrowser}
          />
        )}
        <EditorPortal>
          <FancyConfirm
            isVisible={!!conflictState}
            title="Overwrite Frame?"
            message={
              conflictState
                ? `Opening "${conflictState.manifest.frameName}" from cloud will replace the existing local frame "${conflictState.existingFrame.name || "Untitled"}" and reset undo history.`
                : ""
            }
            type="warning"
            variant="square"
            mode="confirm"
            confirmText="Overwrite"
            cancelText="Cancel"
            onConfirm={handleConfirmOverwrite}
            onCancel={handleCancelOverwrite}
          />
        </EditorPortal>
      </>
    );
  }

  // Expanded state: full panel
  return (
    <>
      <div
        ref={containerRef}
        className="relative flex flex-col w-[255px] bg-[var(--bg-panel)]/90 backdrop-blur-3xl border border-[var(--border-subtle)] shadow-[0_8px_32px_0_rgba(0,0,0,0.12)] rounded-2xl overflow-hidden"
      >
        {/* --- Header Row --- */}
        <div className="flex items-center w-full h-[48px] shrink-0 justify-start px-3 gap-3">
          <button
            className={styles.trigger.className}
            onClick={toggleMenu}
            title="Account"
          >
            <PremiumCloud isOpen={true} isActive={isSignedIn} />
          </button>

          <div className="flex flex-col items-start leading-tight text-left overflow-hidden pr-2">
            <span className="text-[11px] font-bold text-[var(--text-main)] truncate w-full">
              {isSignedIn ? DEFAULT_CLOUD_URL.replace(/^.*?\/\//, "") : "GPEX-Cloud"}
            </span>
            <span className="text-[9px] font-bold text-[var(--text-muted)] mt-0.5 tracking-wide uppercase">
              {isSignedIn ? user?.email : "Offline"}
            </span>
          </div>
        </div>

        {/* --- Panel Content --- */}
        <div className="flex flex-col w-full px-2 pb-2 gap-0.5">
          <div className={styles.divider.className} />

          {isSignedIn ? (
            <>
              {/* Storage & Sync Status Card */}
              <div className={styles.infoWidget.container}>
                {/* Cloud Storage Section */}
                <div className={styles.infoWidget.storageContainer}>
                  <div className={styles.infoWidget.storageHeader}>
                    <span className={styles.infoWidget.storageLabel}>
                      Cloud Storage
                    </span>
                    <span className={styles.infoWidget.storageValue}>
                      {quota
                        ? `${formatBytes(quota.usedBytes)} / ${formatBytes(quota.totalBytes)}`
                        : "—"}
                    </span>
                  </div>
                  <div className={styles.infoWidget.track}>
                    <div
                      className={styles.infoWidget.bar}
                      style={{ width: `${storagePercent}%` }}
                    />
                  </div>
                  {quota && (
                    <div className="flex items-center justify-between text-[8px] text-[var(--text-muted)] font-bold mt-0.5">
                      <span>
                        {quota.fileCount} file{quota.fileCount !== 1 ? "s" : ""}
                      </span>
                      <span>{storagePercent}%</span>
                    </div>
                  )}
                </div>

                {/* Divider */}
                <div className="h-px w-full bg-[var(--border-subtle)]" />

                {/* Current File Status Section */}
                <div className="flex items-center justify-between">
                  <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest">
                    Current File
                  </span>
                  <SyncStatusIndicator
                    syncStatus={syncStatus}
                    lastSaveResult={lastSaveResult}
                  />
                </div>
              </div>

              <div className={styles.divider.className} />

              {/* Cloud Actions (bottom) */}
              <div className="flex flex-col gap-0.5">
                <button
                  className={styles.menuItem.button}
                  onClick={handleSaveToCloud}
                  disabled={isSaving}
                >
                  <div className={styles.menuItem.icon}>
                    <SaveButtonIcon
                      isSaving={isSaving}
                      syncStatus={syncStatus}
                    />
                  </div>
                  <span className={styles.menuItem.label}>
                    <SaveButtonLabel isSaving={isSaving} />
                  </span>
                  <div className={styles.menuItem.badge}>
                    <SavePhaseIcon phase={savePhase} />
                    <SavePhaseLabel
                      phase={savePhase}
                      lastSaveResult={lastSaveResult}
                    />
                  </div>
                </button>

                <button
                  className={styles.menuItem.button}
                  onClick={handleOpenBrowser}
                >
                  <div className={styles.menuItem.icon}>
                    <FolderOpen size={14} />
                  </div>
                  <span className={styles.menuItem.label}>Cloud Gallery</span>
                </button>

                <button
                  className={styles.menuItem.button}
                  onClick={handleGoToCloud}
                >
                  <div className={styles.menuItem.icon}>
                    <ExternalLink size={14} />
                  </div>
                  <span className={styles.menuItem.label}>
                    Go to GPEX Cloud
                  </span>
                </button>

                <div className={styles.divider.className} />

                <button
                  className={styles.menuItemDestructive.button}
                  onClick={signOut}
                >
                  <div className={styles.menuItemDestructive.icon}>
                    <LogOut size={14} />
                  </div>
                  <span className={styles.menuItemDestructive.label}>
                    Log Out
                  </span>
                </button>
              </div>
            </>
          ) : (
            <div className="p-3 flex flex-col items-center text-center gap-3">
              <p className="text-[10px] leading-relaxed text-[var(--text-muted)] font-medium">
                Create a free account to get{" "}
                <strong className="text-[var(--text-main)]">100 MB</strong>{" "}
                cloud storage for syncing your creations across devices.
              </p>
              <button
                className="w-full h-8 flex items-center justify-center gap-1.5 rounded-lg text-[10px] font-bold bg-gradient-to-r from-[#00F2FE] to-[#4FACFE] text-zinc-950 hover:brightness-110 active:scale-[0.98] transition-all cursor-pointer shadow-md shadow-[#00F2FE]/10 border-0 outline-none"
                onClick={() => {
                  setIsOpen(false);
                  openLogin();
                }}
              >
                <LogIn size={12} />
                <span>Sign In / Up</span>
              </button>
              <a
                href={DEFAULT_CLOUD_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full h-8 flex items-center justify-center gap-1.5 rounded-lg text-[10px] font-bold border border-[var(--border-subtle)] hover:border-[var(--border-light)] bg-[var(--bg-stage)] hover:bg-[var(--bg-header)] text-[var(--text-main)] transition-all cursor-pointer no-underline"
              >
                <ExternalLink size={12} />
                <span>Go to GPEX-Cloud</span>
              </a>
            </div>
          )}
        </div>
      </div>

      {/* Portal-level modals */}
      {showBrowser && (
        <CloudBrowser
          onSelect={handleSelectFile}
          onDelete={handleDeleteFile}
          onClose={handleCloseBrowser}
        />
      )}
      <EditorPortal>
        <FancyConfirm
          isVisible={!!conflictState}
          title="Overwrite Frame?"
          message={
            conflictState
              ? `Opening "${conflictState.manifest.frameName}" from cloud will replace the existing local frame "${conflictState.existingFrame.name || "Untitled"}" and reset undo history.`
              : ""
          }
          type="warning"
          variant="square"
          mode="confirm"
          confirmText="Overwrite"
          cancelText="Cancel"
          onConfirm={handleConfirmOverwrite}
          onCancel={handleCancelOverwrite}
        />
      </EditorPortal>
    </>
  );
}
