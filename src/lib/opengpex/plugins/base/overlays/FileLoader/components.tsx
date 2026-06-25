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

import { useState, useEffect, useRef } from "react";
import {
  ImagePlus,
  Loader2,
  Upload,
  Sparkles,
  Layers,
  Paintbrush,
  Scissors,
  Zap,
} from "lucide-react";
import EditorHUD from "@opengpex/editor/widgets/EditorHUD";
import FunctionButton from "@opengpex/editor/widgets/FunctionButton";
import {
  usePluginCommands,
  useEditorState,
} from "@opengpex/editor/core/context";

/**
 * FileLoaderComponent: Flagship global drag-and-drop service component (main component)
 */
export function FileLoaderComponent() {
  const { importCmd } = usePluginCommands();
  const [isOver, setIsOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { state } = useEditorState();
  const isTranscoding = !!state.interaction.signals["sys.asset.transcoding"];
  const isDownloading = !!state.interaction.signals["sys.asset.downloading"];

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer?.types.includes("Files")) setIsOver(true);
    };

    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setIsOver(false);
    };

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setIsOver(false);
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) importCmd?.execute(Array.from(files));
    };

    const onTriggerPicker = () => fileInputRef.current?.click();

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("editor:trigger-file-picker", onTriggerPicker);

    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("editor:trigger-file-picker", onTriggerPicker);
    };
  }, [importCmd]);

  return (
    <div
      className={`absolute inset-0 z-[100] pointer-events-none transition-all duration-300 ${isOver ? "bg-indigo-600/5 backdrop-blur-[2px]" : ""}`}
    >
      <input
        type="file"
        ref={fileInputRef}
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            importCmd?.execute(Array.from(e.target.files));
          }
          e.target.value = "";
        }}
        accept="image/*"
        multiple
        className="hidden"
      />

      {/* Drag visual feedback */}
      <div
        className={`absolute inset-0 border-[6px] border-dashed border-indigo-500/20 transition-opacity duration-300 ${isOver ? "opacity-100" : "opacity-0"}`}
      />

      <div className="absolute inset-0 flex items-center justify-center p-4">
        <EditorHUD
          isVisible={isOver}
          title="Ready to Drop"
          subtitle="Release to add as new project"
          icon={
            <div className="w-5 h-5 bg-indigo-600 rounded-full flex items-center justify-center shadow-lg shadow-indigo-600/40 transform-gpu animate-pulse">
              <ImagePlus size={11} className="text-white" strokeWidth={3} />
            </div>
          }
        />
        <EditorHUD
          isVisible={isTranscoding || isDownloading}
          title={isTranscoding ? "Converting…" : "Downloading…"}
          subtitle={
            isTranscoding
              ? "Transcoding file for engine"
              : "Fetching remote asset"
          }
          icon={
            <div className="w-5 h-5 bg-amber-500 rounded-full flex items-center justify-center shadow-lg shadow-amber-500/40">
              <Loader2
                size={11}
                className="text-white animate-spin"
                strokeWidth={3}
              />
            </div>
          }
        />
      </div>
    </div>
  );
}

/**
 * FileLoaderAction: Trigger button contributed to TOOL_BAR
 */
export function FileLoaderAction() {
  const { pickCmd } = usePluginCommands();

  return (
    <>
      <FunctionButton
        onClick={() => pickCmd?.execute()}
        title={`Upload Image (${pickCmd?.shortcutLabel || ""})`}
        tooltipPosition="right"
        variant="glass"
      >
        <ImagePlus size={18} />
      </FunctionButton>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   FileLoaderLandingAction: Creative start screen (Photoshop-inspired)
   Contributed to LANDING_PAGE slot — this is the main content users see
   when no project is open.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Detect macOS for shortcut labels */
const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const modKey = isMac ? "⌘" : "Ctrl";

/** Feature pill data */
const FEATURES = [
  { icon: Zap, label: "60fps", color: "text-amber-400" },
  { icon: Layers, label: "Layers", color: "text-indigo-400" },
  { icon: Paintbrush, label: "Brush", color: "text-pink-400" },
  { icon: Scissors, label: "Clip", color: "text-emerald-400" },
  { icon: Sparkles, label: "Plugins", color: "text-cyan-400" },
];

export function FileLoaderLandingAction() {
  const { pickCmd } = usePluginCommands();

  return (
    <div className="w-full max-w-md space-y-8 text-center lg:text-left animate-[fadeInUp_0.6s_ease-out_both]">
      {/* ─── Branding ─── */}
      <div className="space-y-3">
        {/* Logo + wordmark */}
        <div className="flex items-center gap-3 justify-center lg:justify-start">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <svg viewBox="0 0 40 40" className="w-5 h-5">
              <path
                d="M 31.369 7.338 L 8.714 8.377 L 7.965 32.738 L 32.27 32.673 L 30.98 18.293 L 19.844 17.269 L 18.051 23.272 L 25.925 23.159 L 25.764 26.967 L 12.783 27.013 L 14.499 12.844 L 31.568 13.097"
                fill="white"
              />
            </svg>
          </div>
          <span className="text-lg font-black tracking-tight bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
            OpenGPEX
          </span>
        </div>

        {/* Tagline */}
        <h1 className="text-2xl sm:text-3xl font-black text-[var(--text-main)] tracking-tight leading-[1.1]">
          What will you{" "}
          <span className="bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent">
            create
          </span>{" "}
          today?
        </h1>
      </div>

      {/* ─── Quick Actions ─── */}
      <div className="space-y-3">
        {/* Primary: Open File */}
        <button
          onClick={() => pickCmd?.execute()}
          className="group relative w-full flex items-center gap-4 px-5 py-4 rounded-2xl
            bg-[var(--bg-panel)]/60 dark:bg-white/[0.04]
            border border-[var(--border-subtle)] dark:border-white/[0.08]
            hover:border-indigo-500/40 dark:hover:border-indigo-400/30
            hover:bg-[var(--bg-panel)] dark:hover:bg-white/[0.07]
            backdrop-blur-md transition-all duration-300 cursor-pointer
            shadow-sm hover:shadow-lg hover:shadow-indigo-500/5
            active:scale-[0.98]"
        >
          {/* Icon */}
          <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-md shadow-indigo-500/20 group-hover:shadow-lg group-hover:shadow-indigo-500/30 transition-shadow">
            <Upload size={18} className="text-white" strokeWidth={2.5} />
          </div>
          {/* Text */}
          <div className="flex-1 text-left min-w-0">
            <div className="text-sm font-bold text-[var(--text-main)] group-hover:text-indigo-500 dark:group-hover:text-indigo-400 transition-colors">
              Open Image
            </div>
            <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
              PNG, JPEG, WebP, GIF, SVG, GPEX
            </div>
          </div>
          {/* Shortcut badge */}
          <div className="flex-shrink-0 hidden sm:flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[var(--bg-stage)] dark:bg-white/[0.06] text-[var(--text-muted)] border border-[var(--border-subtle)]">
              {modKey}
            </kbd>
            <kbd className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[var(--bg-stage)] dark:bg-white/[0.06] text-[var(--text-muted)] border border-[var(--border-subtle)]">
              O
            </kbd>
          </div>
          {/* Hover glow */}
          <div className="absolute inset-0 rounded-2xl bg-gradient-to-r from-indigo-500/0 to-purple-500/0 group-hover:from-indigo-500/[0.03] group-hover:to-purple-500/[0.03] transition-all duration-300 pointer-events-none" />
        </button>

        {/* Secondary: Drag & Drop */}
        <div
          className="relative w-full flex items-center gap-4 px-5 py-3.5 rounded-2xl
            border border-dashed border-[var(--border-subtle)] dark:border-white/[0.06]
            bg-transparent hover:bg-[var(--bg-panel)]/30 dark:hover:bg-white/[0.02]
            transition-all duration-300"
        >
          <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-[var(--bg-stage)] dark:bg-white/[0.04] border border-[var(--border-subtle)] dark:border-white/[0.06] flex items-center justify-center">
            <ImagePlus
              size={18}
              className="text-[var(--text-muted)]"
              strokeWidth={1.5}
            />
          </div>
          <div className="flex-1 text-left min-w-0">
            <div className="text-sm font-semibold text-[var(--text-muted)]">
              Drag & Drop
            </div>
            <div className="text-[10px] text-[var(--text-muted)]/60 mt-0.5">
              Drop any image file onto the workspace
            </div>
          </div>
        </div>

        {/* Tertiary: Paste from Clipboard */}
        <div
          className="relative w-full flex items-center gap-4 px-5 py-3.5 rounded-2xl
            border border-dashed border-[var(--border-subtle)] dark:border-white/[0.06]
            bg-transparent hover:bg-[var(--bg-panel)]/30 dark:hover:bg-white/[0.02]
            transition-all duration-300"
        >
          <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-[var(--bg-stage)] dark:bg-white/[0.04] border border-[var(--border-subtle)] dark:border-white/[0.06] flex items-center justify-center">
            <Upload
              size={18}
              className="text-[var(--text-muted)]"
              strokeWidth={1.5}
            />
          </div>
          <div className="flex-1 text-left min-w-0">
            <div className="text-sm font-semibold text-[var(--text-muted)]">
              Paste from Clipboard
            </div>
            <div className="text-[10px] text-[var(--text-muted)]/60 mt-0.5">
              {modKey}+V to paste an image directly from clipboard
            </div>
          </div>
        </div>
      </div>

      {/* ─── Feature Pills ─── */}
      <div className="flex flex-wrap gap-2 justify-center lg:justify-start pt-2">
        {FEATURES.map(({ icon: Icon, label, color }) => (
          <div
            key={label}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full
              bg-[var(--bg-panel)]/40 dark:bg-white/[0.03]
              border border-[var(--border-subtle)]/50 dark:border-white/[0.05]
              backdrop-blur-sm"
          >
            <Icon size={10} className={color} strokeWidth={2.5} />
            <span className="text-[9px] font-bold tracking-wide text-[var(--text-muted)] uppercase">
              {label}
            </span>
          </div>
        ))}
      </div>

      {/* ─── Version tag ─── */}
      <div className="pt-2">
        <span className="text-[9px] font-mono text-[var(--text-muted)]/40 tracking-wider">
          v1.0 · Open Source · GPL-3.0
        </span>
      </div>

      {/* ─── Animation keyframes ─── */}
      <style>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
