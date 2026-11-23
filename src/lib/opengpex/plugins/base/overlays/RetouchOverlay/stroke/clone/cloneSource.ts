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

/**
 * Clone source registry — per-frame, frameId-keyed, module-level mutable
 * (the same pattern as the stroke session / pendingBake holders in
 * `interactions.ts`).
 *
 * Each frame's entry holds TWO coordinates:
 * - `anchor`: where the user Alt+Clicked (the copy origin's canvas location);
 * - `origin`: the stroke point whose stamp showed the anchor content — the
 *   aligned-offset reference. Captured at the FIRST stroke after a pick and
 *   then PERSISTS across strokes, so lifting the pointer and pressing again
 *   continues the same source film instead of restarting it at the anchor
 *   (Photoshop aligned semantics). Re-picking resets `origin`.
 *
 * Frames are independent: switching frames never disturbs other entries.
 * A persistence host (the overlay's React layer) mirrors the registry into
 * `CraftDrawerConfig.retouchCloneSources` via `exportCloneSources` /
 * `restoreCloneSource`, so sources survive page refreshes (validated by
 * frame id + canvas bounds on restore).
 */

import type { Point2D } from '../types';

export interface CloneSourceEntry {
  anchor: Point2D;
  /** Aligned-offset reference; null until the first stroke after a pick. */
  origin: Point2D | null;
}

/** Registry cap: oldest entries (insertion order) are pruned beyond this. */
const MAX_ENTRIES = 20;

const entries = new Map<string, CloneSourceEntry>();

const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

function prune(): void {
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** Snapshot for the given frame — stable reference between mutations. */
export function getCloneSourceFor(frameId: string): CloneSourceEntry | null {
  return entries.get(frameId) ?? null;
}

/** The aligned-offset reference for a frame (null when unset). */
export function getCloneOriginFor(frameId: string): Point2D | null {
  return entries.get(frameId)?.origin ?? null;
}

/** Alt+Click pick for a frame: (re)sets the anchor and invalidates the offset. */
export function pickCloneSource(frameId: string, anchor: Point2D): void {
  entries.set(frameId, { anchor: { x: anchor.x, y: anchor.y }, origin: null });
  prune();
  notify();
}

/**
 * Stroke begin (clone mode): establishes the aligned-offset reference on the
 * first stroke after a pick; later strokes keep the existing one so the
 * sampled film continues seamlessly across pointer lifts.
 */
export function beginCloneStroke(frameId: string, point: Point2D): void {
  const entry = entries.get(frameId);
  if (!entry || entry.origin !== null) return;
  entry.origin = { x: point.x, y: point.y };
  notify();
}

/** Clears ONE frame's source (Escape / the panel's clear affordance). */
export function clearCloneSourceFor(frameId: string): void {
  if (!entries.delete(frameId)) return;
  notify();
}

/** Whole-registry export for the persistence host. */
export function exportCloneSources(): Record<string, CloneSourceEntry> {
  const out: Record<string, CloneSourceEntry> = {};
  for (const [frameId, e] of entries) {
    out[frameId] = { anchor: { ...e.anchor }, origin: e.origin ? { ...e.origin } : null };
  }
  return out;
}

/**
 * Persistence-restore for one frame. Skipped when the module already holds
 * live state for the frame (session memory is authoritative), or when the
 * restored coordinates fall outside the frame canvas (stale entry).
 */
export function restoreCloneSource(
  frameId: string,
  canvas: { w: number; h: number },
  entry: CloneSourceEntry | undefined,
): void {
  if (!entry || entries.has(frameId)) return;
  const inside = (p: Point2D) => p.x >= 0 && p.y >= 0 && p.x < canvas.w && p.y < canvas.h;
  if (!inside(entry.anchor) || (entry.origin && !inside(entry.origin))) return;
  entries.set(frameId, { anchor: { ...entry.anchor }, origin: entry.origin ? { ...entry.origin } : null });
  notify();
}

/** Subscribes to registry changes; returns the unsubscribe function. */
export function subscribeCloneSource(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
