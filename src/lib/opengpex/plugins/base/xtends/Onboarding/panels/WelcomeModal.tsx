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

import React, { useState, useEffect } from "react";
import { X, Zap, ArrowUpRight } from "lucide-react";

// ─── WelcomeModal ─────────────────────────────────────────────────────────────

export function WelcomeModal({
  onDismiss,
}: {
  /** Called with `forever=true` when "Don't show again" is checked, otherwise `false` */
  onDismiss: (forever: boolean) => void;
}) {
  const [visible, setVisible] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  // Animate in after mount
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 60);
    return () => clearTimeout(t);
  }, []);

  const handleDismiss = () => {
    setVisible(false);
    setTimeout(() => onDismiss(dontShowAgain), 250);
  };

  return (
    /* Backdrop — no blur, no click-to-close */
    <div
      className="fixed inset-0 flex items-center justify-center pointer-events-auto"
      style={{ background: "rgba(0,0,0,0.45)" }}
    >
      {/* Modal card */}
      <div
        className="relative bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-2xl shadow-2xl shadow-black/40 w-[480px] max-w-[92vw] overflow-hidden"
        style={{
          transform: visible ? "scale(1) translateY(0)" : "scale(0.94) translateY(12px)",
          opacity: visible ? 1 : 0,
          transition: "transform 0.25s cubic-bezier(0.16,1,0.3,1), opacity 0.25s ease",
        }}
      >
        {/* Gradient accent strip */}
        <div
          className="absolute top-0 inset-x-0 h-[2px]"
          style={{
            background: "linear-gradient(90deg, #6366f1 0%, #818cf8 50%, #a5b4fc 100%)",
          }}
        />

        {/* Shimmer background */}
        <div
          className="absolute inset-0 opacity-[0.04] pointer-events-none"
          style={{
            background: "radial-gradient(ellipse 80% 60% at 50% 0%, #818cf8 0%, transparent 70%)",
          }}
        />

        <div className="relative px-7 py-6">
          {/* Header */}
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center">
                <Zap size={14} className="text-indigo-400" />
              </div>
              <div>
                <h2 className="text-[15px] font-bold text-[var(--text-main)] leading-tight">
                  Welcome to OpenGPEX v2
                </h2>
                <p className="text-[11.5px] text-indigo-400 font-medium">
                  Now powered by WebGPU
                </p>
              </div>
            </div>
            <button
              onClick={handleDismiss}
              className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-[var(--bg-hover)] transition-colors mt-0.5"
              title="Close"
            >
              <X size={12} className="text-[var(--text-muted)]" />
            </button>
          </div>

          {/* Body */}
          <div className="space-y-3 text-[13px] text-[var(--text-main)]/85 leading-[1.65]">
            <p>
              v2 upgrades the rendering engine to{" "}
              <span className="text-indigo-300 font-semibold">WebGPU</span>, delivering
              smoother performance and support for much larger images.
            </p>
            <p>
              If you&apos;re upgrading from v1, your work migrates automatically — and
              even if something goes wrong, your files remain safely stored in your browser.
            </p>
            <p className="text-[var(--text-muted)]">
              Hit a snag? Open an issue on{" "}
              <a
                href="https://github.com/gpex-cloud/opengpex/issues"
                target="_blank"
                rel="noreferrer"
                className="text-indigo-400 hover:text-indigo-300 transition-colors inline-flex items-center gap-0.5"
              >
                GitHub <ArrowUpRight size={10} />
              </a>
              {" "}and I&apos;ll help you sort it out. If your device struggles with v2,
              the legacy editor is still at{" "}
              <a
                href="https://v1.gpex.cloud"
                target="_blank"
                rel="noreferrer"
                className="text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                v1.gpex.cloud
              </a>
              {" "}(manual file migration required).
            </p>
          </div>

          {/* Footer */}
          <div className="mt-5 flex items-center justify-between">
            {/* Don't show again checkbox */}
            <label className="flex items-center gap-2 cursor-pointer select-none group">
              <div className="relative">
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={dontShowAgain}
                  onChange={(e) => setDontShowAgain(e.target.checked)}
                />
                <div
                  className={`w-3.5 h-3.5 rounded-[3px] border flex items-center justify-center transition-colors ${
                    dontShowAgain
                      ? "bg-indigo-500 border-indigo-500"
                      : "border-[var(--border-subtle)] bg-[var(--bg-stage)] group-hover:border-indigo-400"
                  }`}
                >
                  {dontShowAgain && (
                    <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
                      <path d="M1 3L3 5L7 1" stroke="white" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>
              </div>
              <span className="text-[11px] text-[var(--text-muted)] group-hover:text-[var(--text-main)] transition-colors">
                Don&apos;t show again
              </span>
            </label>

            <button
              onClick={handleDismiss}
              className="px-4 py-1.5 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white text-[12px] font-semibold transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
