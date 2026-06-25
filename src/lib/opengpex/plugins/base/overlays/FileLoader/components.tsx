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
import { ImagePlus, Loader2 } from "lucide-react";
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
      {/* <FunctionButton
        onClick={() => {}}
        title="Open from Gallery"
        tooltipPosition="right"
        variant="glass"
      >
        <ImageIcon size={18} />
      </FunctionButton> */}
    </>
  );
}

/**
 * FileLoaderLandingAction: Initial guide component contributed to LANDING_PAGE
 */
export function FileLoaderLandingAction() {
  const { pickCmd } = usePluginCommands();

  return (
    <div className="space-y-4 max-w-sm relative">
      <h2 className="text-2xl font-black text-zinc-900 dark:text-white/90 tracking-tighter leading-none italic uppercase">
        Ready for Creativity?
      </h2>
      <p className="text-[10px] font-black text-zinc-500 tracking-[0.2em] uppercase">
        Drag & Drop an image here or use the loader
      </p>
      <div className="pt-6">
        <button
          onClick={() => pickCmd?.execute()}
          className="group relative px-8 py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-black uppercase tracking-[0.2em] transition-all shadow-xl shadow-indigo-600/20 active:scale-95"
        >
          <span className="relative z-10">Start New Editing</span>
          <div className="absolute inset-0 bg-white/20 rounded-2xl scale-x-0 group-hover:scale-x-100 origin-left transition-transform duration-500" />
        </button>
      </div>
    </div>
  );
}
