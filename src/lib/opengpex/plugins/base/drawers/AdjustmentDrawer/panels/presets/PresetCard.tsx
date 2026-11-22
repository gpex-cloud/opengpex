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

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { FilterPreset } from "@opengpex/editor/plugins/base/drawers/AdjustmentDrawer/grading/presets/preset-chain";


// ─── PresetCard ────────────────────────────────────────────────────────────────

export const PresetCard = React.memo(function PresetCard({
  preset,
  selected,
  pending,
  onSelect,
  registerCanvas,
  onDelete,
  onRename,
}: {
  preset: FilterPreset;
  selected: boolean;
  pending: boolean;
  onSelect: (preset: FilterPreset) => void;
  registerCanvas: (id: string, el: HTMLCanvasElement | null) => void;
  /** Present only on custom presets — renders the small delete affordance. */
  onDelete?: (id: string) => void;
  /** Present only on custom presets — commit a renamed label. */
  onRename?: (id: string, name: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Inline rename state lives on the card: `null` = displaying the label;
  // a string = the draft being edited. Built-in cards never get `onRename`,
  // so they can never enter this state.
  const [renameDraft, setRenameDraft] = useState<string | null>(null);

  useEffect(() => {
    const el = canvasRef.current;
    registerCanvas(preset.id, el);
    return () => registerCanvas(preset.id, null);
  }, [preset.id, registerCanvas]);

  const commitRename = useCallback(() => {
    if (renameDraft === null) return;
    const name = renameDraft.trim();
    setRenameDraft(null);
    // An emptied label keeps the current name — renaming never destroys.
    if (!name || name === preset.name) return;
    onRename?.(preset.id, name);
  }, [renameDraft, preset.id, preset.name, onRename]);

  return (
    // The wrapper owns positioning so the delete button can sit ON the card
    // without being nested inside the card <button> (invalid HTML), and so
    // the name label / rename input can live OUTSIDE the button too — a
    // double-click on the label must not toggle the preset selection.
    <div className="relative">
      <button
        type="button"
        onClick={() => onSelect(preset)}
        title={preset.name}
        className={`flex w-full flex-col items-center gap-0.5 p-0.5 rounded-lg border outline-none focus:outline-none transition-colors ${
          selected
            ? "border-[var(--accent-primary,#60a5fa)] bg-[var(--accent-primary,#60a5fa)]/10"
            : "border-zinc-200 dark:border-white/10 hover:bg-zinc-100 dark:hover:bg-white/5"
        }`}
      >
        <canvas
          ref={canvasRef}
          width={80}
          height={45}
          className={`w-full rounded-md object-cover bg-zinc-200 dark:bg-black/40 ${
            pending ? "animate-pulse opacity-60" : ""
          }`}
          style={{ aspectRatio: "16 / 9" }}
        />
      </button>
      {renameDraft === null ? (
        <span
          onDoubleClick={onRename ? () => setRenameDraft(preset.name) : undefined}
          title={onRename ? "Double-click to rename" : undefined}
          className={`block w-full text-center text-[9px] leading-none tracking-tight select-none truncate max-w-full mt-0.5 ${
            selected
              ? "text-[var(--accent-primary,#60a5fa)] font-black"
              : "text-[var(--text-muted)] font-bold"
          }`}
        >
          {preset.name}
        </span>
      ) : (
        <input
          autoFocus
          value={renameDraft}
          onChange={(e) => setRenameDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') {
              // Consume the event before it bubbles to the document: the
              // active craft overlays listen for Escape at the document level
              // to deactivate the tool, and a rename edit must not eject it.
              e.preventDefault();
              e.stopPropagation();
              setRenameDraft(null);
            }
          }}
          onBlur={commitRename}
          aria-label={`Rename preset ${preset.name}`}
          className="w-full h-4 mt-0.5 px-0.5 text-[9px] font-bold bg-[var(--bg-stage)] border border-[var(--border-subtle)] rounded outline-none focus:border-indigo-500/50 text-[var(--text-primary)]"
        />
      )}
      {onDelete && (
        <button
          type="button"
          onClick={(e) => {
            // Keep the click off the card underneath: the badge overlaps the
            // card's corner, and a stray click here must never select.
            e.stopPropagation();
            onDelete(preset.id);
          }}
          aria-label={`Delete preset ${preset.name}`}
          title={`Delete ${preset.name}`}
          className="absolute top-0.5 right-0.5 w-3.5 h-3.5 flex items-center justify-center rounded-full bg-zinc-300 dark:bg-zinc-600 text-[9px] font-black leading-none text-[var(--text-main)] hover:bg-red-500 hover:text-white outline-none focus:outline-none transition-colors"
        >
          ×
        </button>
      )}
    </div>
  );
});

