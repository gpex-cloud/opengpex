/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Internal shared types for the importers module.
 * Extracted to break the circular dependency between index.ts ↔ single/multi.ts.
 */

// ─── Importing Signal (shared between core importer + FileLoader UI) ─────────

/** Signal key for the unified importing progress indicator. */
export const SIGNAL_IMPORTING = 'sys.asset.importing';

/**
 * Shape of the importing signal value stored in state.interaction.signals.
 *
 * Two producers share one signal + HUD:
 * - Batch file import fills `current`/`total` (title renders "Loading 2/5…").
 * - Frame revert (always a single source) fills only `label` — the progress
 *   pair would be meaningless noise there.
 */
export interface ImportingSignalValue {
  /** Explicit HUD title override; takes precedence over progress rendering. */
  label?: string;
  /** Explicit HUD subtitle override; falls back to the import subtitle. */
  subtitle?: string;
  /** 1-based index of current file (batch import only). */
  current?: number;
  /** Total number of files in the batch (batch import only). */
  total?: number;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options common to single-image and multi-sub-image import strategies.
 *
 * `extra` carries caller-defined frame-level tags with no protocol behind it
 * (e.g. AIBridgeDrawer/ComfyBridgeDrawer attach `ai_generation`/`ai_provider`/
 * `ai_seed`/... here, later read by ImageInfoDrawer's AiGenerationPanel).
 * Loosely typed by design — do not remove without checking real callers in
 * `plugins/base/drawers/*`, not just the protocol constant references.
 */
export interface ImportOptions {
  /** Whether to switch viewport to the newly created frame */
  switchFrame: boolean;
  /** DPI for the frame (from vector dialog or source metadata). Finalized
   *  once by `resolveAndDecode` — never re-derived downstream. */
  dpi?: number;
  /** If set, frame is created as a child (branch) of this parent frame */
  parentId?: string;
  /** Branch sequence number (e.g. "Branch#2") — only meaningful when parentId is set */
  seqNum?: string;
  /** Override the frame name (defaults to file name without extension) */
  nameOverride?: string;
  /** Caller-defined frame-level tags (AI generation metadata, etc.) — passed through untouched. */
  extra?: Record<string, unknown>;
}

