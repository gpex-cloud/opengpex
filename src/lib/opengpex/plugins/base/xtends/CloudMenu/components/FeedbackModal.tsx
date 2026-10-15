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

/* eslint-disable react-hooks/set-state-in-effect */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  MessageSquareQuote,
  Copy,
  ChevronDown,
  ChevronRight,
  Loader2,
  Send,
  History,
  ClipboardList,
} from "lucide-react";
import { PopupPanel } from "@opengpex/editor/widgets/PopupPanel";
import FunctionTabs from "@opengpex/editor/widgets/FunctionTabs";
import { useGpexCloud } from "@opengpex/editor/core/cloud";
import { useEditorState, useEditorServices } from "@opengpex/editor/core/context";
import { getOrCreateClientId } from "@opengpex/editor/core/system/client-id";
import type { GpuInfo } from "@opengpex/editor/core/engine/gpu/GpuInfo";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  GPU_UNAVAILABLE_SNAPSHOT,
  appendLocalFeedback,
  buildFeedbackPayload,
  fetchMyFeedback,
  mergeHistory,
  projectDiagnostics,
  readLocalFeedback,
  submitFeedback,
  type FeedbackCategory,
  type FeedbackDiagnostics,
  type FeedbackHistoryItem,
  type LocalFeedbackEntry,
} from "../feedback";
// IMPORTANT: Must use relative path to ensure importing the exact same in-memory
// token-store instance as other auth files. Do NOT replace with alias path.
import { getAccessToken } from "../../../../../core/cloud/auth/token-store";

// ─── Small presentational metadata ───────────────────────────────────────────

const CATEGORY_META: Record<FeedbackCategory, { label: string; icon: string }> = {
  bug: { label: "Issue", icon: "⚠️" },
  feature: { label: "Idea", icon: "💡" },
  general: { label: "Other", icon: "💬" },
};

const STATUS_META: Record<string, { label: string; className: string }> = {
  new: { label: "New", className: "bg-sky-500/15 text-sky-500 dark:text-sky-400" },
  resolved: { label: "Resolved", className: "bg-emerald-500/15 text-emerald-500 dark:text-emerald-400" },
  rejected: { label: "Rejected", className: "bg-zinc-500/15 text-zinc-500 dark:text-zinc-400" },
};

/** Tinted square behind the category emoji, one hue per category. */
const CATEGORY_BG: Record<FeedbackCategory, string> = {
  bug: "bg-rose-500/10",
  feature: "bg-amber-500/10",
  general: "bg-sky-500/10",
};

function formatDate(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * FeedbackModal: compose + History (past submissions & replies) in one PopupPanel.
 *
 * Identity is implicit: signed-in submissions carry the session Bearer (shown
 * as "Sending as"), signed-out ones are a zero-input anonymous drop. Failure
 * never destroys the draft — the modal stays open with the text intact and
 * offers a clipboard fallback.
 */
export function FeedbackModal({ onClose }: { onClose: () => void }) {
  const { isSignedIn, user } = useGpexCloud();
  const { pixels, actions } = useEditorServices();
  const { activeFrame } = useEditorState();

  const [view, setView] = useState<"compose" | "history">("compose");
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [rateLimitMinutes, setRateLimitMinutes] = useState<number | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<FeedbackDiagnostics | null>(null);

  // My Feedback: cloud rows (signed-in only) + the device-local log.
  const [cloudItems, setCloudItems] = useState<FeedbackHistoryItem[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [localEntries, setLocalEntries] = useState<LocalFeedbackEntry[]>(() => readLocalFeedback());

  /** Click-time snapshot of everything this submission will attach. The
   * engine surface is read defensively: a dead/unbooted engine must report
   * `GPU ready: false`, not throw. */
  const collectDiagnostics = useCallback((): FeedbackDiagnostics => {
    let gpu: GpuInfo = GPU_UNAVAILABLE_SNAPSHOT;
    try {
      gpu = pixels?.system?.gpuInfo?.() ?? GPU_UNAVAILABLE_SNAPSHOT;
    } catch {
      // Engine not ready — keep the unavailable snapshot.
    }
    const canvas = activeFrame?.canvas;
    return projectDiagnostics({
      gpu,
      userAgent: navigator.userAgent,
      screenWidth: screen.width,
      screenHeight: screen.height,
      devicePixelRatio: window.devicePixelRatio,
      ...(canvas ? { canvasSize: { width: canvas.w, height: canvas.h } } : {}),
    });
  }, [pixels, activeFrame]);

  const toggleDiagnostics = useCallback(() => {
    // Snapshot at expand time so the panel shows the exact current state.
    if (!diagnosticsOpen) setDiagnostics(collectDiagnostics());
    setDiagnosticsOpen((prev) => !prev);
  }, [diagnosticsOpen, collectDiagnostics]);

  // ─── Submit ────────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    const trimmed = message.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setFailed(false);
    setRateLimitMinutes(null);

    const payload = buildFeedbackPayload(category, trimmed, collectDiagnostics());
    const result = await submitFeedback(payload, {
      clientId: getOrCreateClientId() || undefined,
      ...(isSignedIn ? { accessToken: getAccessToken() ?? undefined } : {}),
    });

    setSubmitting(false);

    if (result.ok) {
      // Local log records every submission (signed-in ones too) so the
      // History list keeps its entries even before the cloud row is
      // visible; the merge dedupes once the cloud list arrives.
      appendLocalFeedback({
        feedbackId: result.feedbackId || crypto.randomUUID(),
        category,
        message: trimmed,
        createdAt: new Date().toISOString(),
      });
      setLocalEntries(readLocalFeedback());
      setCloudItems(null); // force a refetch next time the history opens
      setMessage("");
      actions.notifyHUD("✓ Feedback sent — thank you!");
      setTimeout(onClose, 700);
    } else if (result.reason === "rate_limited") {
      const minutes = Math.max(1, Math.ceil(result.retryAfterSeconds / 60));
      setRateLimitMinutes(minutes);
      actions.notifyHUD(`⚠️ Submissions too frequent — try again in ${minutes} min`, "error");
    } else {
      setFailed(true);
      actions.notifyHUD("⚠️ Feedback failed to send — your draft is preserved", "error");
    }
  }, [message, submitting, category, isSignedIn, collectDiagnostics, actions, onClose]);

  const handleCopyFallback = useCallback(() => {
    const text = [
      `Category: ${category}`,
      `Message:`,
      message,
      "",
      "Diagnostics:",
      JSON.stringify(diagnostics ?? collectDiagnostics(), null, 2),
    ].join("\n");
    navigator.clipboard?.writeText(text).catch(() => {});
  }, [category, message, diagnostics, collectDiagnostics]);

  // ─── History ───────────────────────────────────────────────────────────────

  // In-flight flag lives in a ref ON PURPOSE: putting historyLoading in the
  // dependency array re-runs this effect mid-request and the cleanup cancels
  // the fetch before anything can clear the spinner (stuck-loading bug).
  const historyInflight = useRef(false);

  useEffect(() => {
    if (view !== "history") return;
    setLocalEntries(readLocalFeedback());
    // One fetch per open; cloudItems !== null (even an empty array) marks the
    // page as loaded. A failed fetch resolves to null and simply isn't cached,
    // so the next open retries.
    if (!isSignedIn || cloudItems !== null || historyInflight.current) return;
    const token = getAccessToken();
    if (!token) return;
    historyInflight.current = true;
    setHistoryLoading(true);
    fetchMyFeedback(token)
      .then((items) => setCloudItems(items))
      .finally(() => {
        historyInflight.current = false;
        setHistoryLoading(false);
      });
  }, [view, isSignedIn, cloudItems]);

  const historyItems = mergeHistory(cloudItems, localEntries);
  const nearLimit = message.length > FEEDBACK_MESSAGE_MAX_LENGTH - 200;

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <PopupPanel
      isVisible={true}
      onClose={onClose}
      title="Send Feedback"
      subTitle={view === "compose" ? "Bugs, ideas, anything" : "History"}
      icon={<MessageSquareQuote size={16} />}
      size="md"
      position="CT"
      closeOnOutsideClick={false}
    >
      {/* flex-1 (not h-full) keeps the height contract with PopupPanel's
          bounded flex column: the tabs row stays pinned and each view owns
          its internal scrolling — the panel body itself never overflows. */}
      <div className="flex flex-col flex-1 min-h-0">
        {/* View switch */}
        <FunctionTabs
          size="sm"
          className="mx-3 mt-1 mb-2.5 shrink-0"
          value={view}
          onChange={setView}
          options={[
            { value: "compose", label: "Compose", icon: <Send size={10} /> },
            { value: "history", label: "History", icon: <History size={10} /> },
          ]}
        />

        {view === "compose" ? (
          <div className="flex flex-col gap-2.5 px-3 pb-3 flex-1 min-h-0">
            {/* Category chips */}
            <div className="flex items-center gap-1.5 shrink-0">
              {FEEDBACK_CATEGORIES.map((c) => (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className={`flex items-center gap-1 px-2.5 h-7 rounded-lg border text-[11px] font-bold transition-all outline-none cursor-pointer ${
                    category === c
                      ? "bg-[var(--bg-stage)] border-[var(--text-muted)]/50 text-[var(--text-main)]"
                      : "bg-transparent border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-main)]"
                  }`}
                >
                  <span>{CATEGORY_META[c].icon}</span>
                  <span>{CATEGORY_META[c].label}</span>
                </button>
              ))}
            </div>

            {/* Message — flex-grows to eat every spare pixel of the modal */}
            <textarea
              autoFocus
              value={message}
              maxLength={FEEDBACK_MESSAGE_MAX_LENGTH}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder="What happened? Paste console output or repro steps if useful."
              className="w-full flex-1 min-h-[96px] resize-none rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] px-3 py-2.5 text-[12px] text-[var(--text-main)] placeholder:text-[var(--text-muted)]/60 outline-none focus:border-[var(--text-muted)]/50 transition-colors"
            />

            {/* Identity + counter row */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[9px] font-bold text-[var(--text-muted)] truncate">
                {isSignedIn && user?.email
                  ? `Sending as: ${user.email}`
                  : "Sending anonymously — no email, no account, nothing that identifies you"}
              </span>
              {nearLimit && (
                <span
                  className={`text-[9px] font-bold shrink-0 ${
                    message.length >= FEEDBACK_MESSAGE_MAX_LENGTH ? "text-red-400" : "text-amber-400"
                  }`}
                >
                  {message.length}/{FEEDBACK_MESSAGE_MAX_LENGTH}
                </span>
              )}
            </div>

            {/* Diagnostics disclosure — shows exactly what will be sent */}
            <div className="rounded-xl border border-[var(--border-subtle)] overflow-hidden shrink-0">
              <button
                onClick={toggleDiagnostics}
                className="flex items-center gap-1.5 w-full px-2.5 h-8 text-left bg-transparent hover:bg-[var(--bg-stage)] transition-colors outline-none cursor-pointer"
              >
                {diagnosticsOpen ? (
                  <ChevronDown size={11} className="text-[var(--text-muted)]" />
                ) : (
                  <ChevronRight size={11} className="text-[var(--text-muted)]" />
                )}
                <span className="text-[10px] font-bold text-[var(--text-muted)]">
                  Environment attached to this message
                </span>
              </button>
              {diagnosticsOpen && diagnostics && (
                <pre className="max-h-40 overflow-auto custom-scrollbar bg-[var(--bg-stage)] px-3 py-2 text-[9px] leading-relaxed text-[var(--text-muted)] whitespace-pre-wrap break-words border-t border-[var(--border-subtle)]">
                  {JSON.stringify(diagnostics, null, 2)}
                </pre>
              )}
            </div>

            {/* Failure / rate-limit banners — the draft always stays intact */}
            {rateLimitMinutes !== null && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[10px] font-bold text-amber-500">
                Submissions too frequent — please retry in {rateLimitMinutes} min. Your draft is
                preserved.
              </div>
            )}
            {failed && (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2">
                <span className="text-[10px] font-bold text-red-400">
                  Send failed — cloud unreachable?
                </span>
                <button
                  onClick={handleCopyFallback}
                  className="flex items-center gap-1 px-2 h-6 rounded-md border border-[var(--border-subtle)] text-[9px] font-bold text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-stage)] transition-all outline-none cursor-pointer shrink-0"
                >
                  <Copy size={9} />
                  Copy to Clipboard
                </button>
              </div>
            )}

            {/* Submit */}
            <button
              onClick={handleSubmit}
              disabled={!message.trim() || submitting}
              className="w-full h-9 flex items-center justify-center gap-1.5 rounded-xl text-[12px] font-bold bg-gradient-to-r from-[#00F2FE] to-[#4FACFE] text-zinc-950 hover:brightness-110 active:scale-[0.98] transition-all cursor-pointer shadow-md shadow-[#00F2FE]/10 border-0 outline-none disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100"
            >
              {submitting ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  Sending…
                </>
              ) : (
                <>
                  <Send size={13} />
                  Send Feedback
                </>
              )}
            </button>
            <span className="text-[8px] text-[var(--text-muted)] text-center -mt-1.5">
              Cmd/Ctrl + Enter to send · No canvas content ever leaves your browser
            </span>
          </div>
        ) : (
          /* ─── History ─── */
          <div className="flex-1 flex flex-col gap-1.5 px-3 pb-3 overflow-y-auto custom-scrollbar min-h-0">
            {historyLoading && (
              <div className="flex flex-col gap-1.5 pt-0.5">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="h-[68px] rounded-xl bg-[var(--bg-stage)] shadow-inner animate-pulse"
                  />
                ))}
              </div>
            )}

            {!historyLoading && historyItems.length === 0 && (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 py-10">
                <div className="w-12 h-12 rounded-2xl bg-[var(--bg-stage)] shadow-inner flex items-center justify-center">
                  <ClipboardList size={20} className="text-[var(--text-muted)] opacity-60" />
                </div>
                <div className="flex flex-col items-center gap-0.5">
                  <p className="text-[11px] font-bold text-[var(--text-main)]">No feedback yet</p>
                  <p className="text-[10px] text-[var(--text-muted)]">
                    Everything you send shows up here.
                  </p>
                </div>
              </div>
            )}

            {!historyLoading &&
              historyItems.map((item) => {
                const badge = STATUS_META[item.status];
                return (
                  <div
                    key={item.feedbackId}
                    className="flex flex-col gap-2 rounded-xl bg-[var(--bg-stage)] shadow-inner p-3"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`w-6 h-6 flex items-center justify-center rounded-lg text-[12px] shrink-0 ${
                          CATEGORY_BG[item.category] ?? "bg-sky-500/10"
                        }`}
                      >
                        {CATEGORY_META[item.category]?.icon ?? "💬"}
                      </span>
                      <span className="text-[11px] font-bold text-[var(--text-main)] shrink-0">
                        {CATEGORY_META[item.category]?.label ?? "Other"}
                      </span>
                      <span className="text-[9px] font-semibold text-[var(--text-muted)] truncate flex-1 text-right">
                        {formatDate(item.createdAt)}
                      </span>
                      {badge && (
                        <span
                          className={`px-2 h-[18px] flex items-center rounded-full text-[8px] font-black uppercase tracking-wide shrink-0 ${badge.className}`}
                        >
                          {badge.label}
                        </span>
                      )}
                      {/* Keyed on origin, not on missing status: a cloud row
                          with an unrecognized status must not read as local. */}
                      {item.origin === "device" && (
                        <span className="px-2 h-[18px] flex items-center rounded-full bg-[var(--bg-panel)] text-[8px] font-black uppercase tracking-wide text-[var(--text-muted)] shrink-0">
                          This device
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] leading-relaxed text-[var(--text-main)]/90 whitespace-pre-wrap break-words">
                      {item.message}
                    </p>
                    {item.replyMessage && (
                      <div className="rounded-lg bg-[var(--bg-panel)] border-l-2 border-[#00A8B0]/60 dark:border-[#00F2FE]/50 pl-2.5 pr-2 py-1.5">
                        <span className="text-[8px] font-black uppercase tracking-widest text-[#007A80] dark:text-[#00F2FE]">
                          Reply{item.repliedAt ? ` · ${formatDate(item.repliedAt)}` : ""}
                        </span>
                        <p className="text-[10px] leading-relaxed text-[var(--text-main)]/90 whitespace-pre-wrap break-words mt-0.5">
                          {item.replyMessage}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}

            {!historyLoading && historyItems.length > 0 && (
              <p className="text-[8px] leading-relaxed text-[var(--text-muted)]/80 text-center pt-1.5">
                {isSignedIn
                  ? "Entries marked “This device” were sent anonymously and live only in this browser."
                  : "Stored only on this device — clearing site data removes them. Anonymous feedback can’t receive replies."}
              </p>
            )}
          </div>
        )}
      </div>
    </PopupPanel>
  );
}
