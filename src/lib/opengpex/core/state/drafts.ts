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
 * drafts — the typed read/write channel for `Frame.drafts`, the
 * per-frame container holding in-progress tool sessions keyed by tool id.
 *
 * Two invariants make the container safe to share between the undo ledger,
 * the persistence layer and every tool, and both are enforced HERE rather
 * than by caller discipline:
 *
 * R1a (memoized read-only contract): `readFrameDraft` returns a DEEP COPY of
 * the stored payload, frozen, cached by the payload's object identity in a
 * WeakMap. React consumers never see a new reference on unrelated re-renders
 * (the cache absorbs them), and an undo/redo that swaps the frame replaces
 * the stored payload object — the WeakMap key misses and a fresh copy is
 * built from the restored data, so stale-cache bugs are structurally
 * impossible.
 *
 * R1b (explicit working copy): nothing outside this module ever holds a
 * reference INTO `Frame.drafts`. A tool that wants to edit a draft clones it
 * once via `cloneFrameDraft` (codec-provided fast clone, `structuredClone`
 * fallback), mutates the private copy during the gesture, and hands the
 * finished copy back through `writeFrameDraft`, which replaces the whole
 * entry while sharing the references of untouched keys. Because no alias to
 * the stored payload can ever leak, an in-place mutation can never corrupt a
 * history checkpoint.
 *
 * Tools declare their payload contract through a `DraftCodec` registered
 * from the plugin's `contributions.state.draftCodec`. The codec doubles as
 * the load-time whitelist: keys without a codec (or failing validation) are
 * dropped when a document is hydrated, so drafts saved by newer builds
 * simply vanish in older ones instead of poisoning the state tree.
 */

import { useMemo } from 'react';
import type { Frame } from '../types/models';

/** Viewport D4 symmetry operations (same set transformFrame applies). */
export type DraftTransformOperation = 'rotate_r' | 'rotate_l' | 'flip_h' | 'flip_v';

/**
 * The per-tool draft contract. `validate` must be cheap and total: it runs
 * on every hydrate of every frame and guards every read, so a malformed
 * payload degrades to "no draft" rather than crashing a consumer.
 */
export interface DraftCodec<T = unknown> {
  /** Tool id — the key this codec owns inside `Frame.drafts`. */
  readonly toolId: string;
  /** Returns the payload when it is structurally valid, else null. */
  validate(v: unknown): T | null;
  /**
   * Optional fast deep-copy for gesture-start working clones. Omit for
   * small/low-frequency payloads (`structuredClone` is the fallback); tools
   * with hot gesture paths (place/drag per pointer event) provide a
   * hand-rolled point-by-point copy to skip the generic traversal.
   */
  clone?(payload: T): T;
  /**
   * Optional viewport-transform hook. When present, `transformFrame` routes
   * this draft through it so the payload's frame-local geometry stays
   * aligned with the pixels across canvas rotate/flip (same undo step as the
   * pixels). Absent ⇒ the payload is passed through untouched (unknown keys
   * survive a rotation verbatim).
   */
  transform?(payload: T, container: { w: number; h: number }, operation: DraftTransformOperation): T;
}

// ─── Codec registry ────────────────────────────────────────────────────────────

const codecs = new Map<string, DraftCodec<unknown>>();

/** Registers (or replaces) the codec owning `toolId`. Called at plugin registration. */
export function registerFrameDraftCodec(codec: DraftCodec<unknown>): void {
  codecs.set(codec.toolId, codec);
}

export function unregisterFrameDraftCodec(toolId: string): void {
  codecs.delete(toolId);
}

export function getFrameDraftCodec(toolId: string): DraftCodec<unknown> | undefined {
  return codecs.get(toolId);
}

export function getFrameDraftCodecs(): DraftCodec<unknown>[] {
  return [...codecs.values()];
}

/** Clears the registry — test isolation only. */
export function resetFrameDraftCodecs(): void {
  codecs.clear();
}

// ─── R1a: memoized read-only copies ────────────────────────────────────────────

const readCache = new WeakMap<object, unknown>();

/**
 * The frozen deep copy of `frame.drafts[toolId]`, or null when the frame has
 * no draft for the tool (or the payload fails codec validation). Same
 * payload reference ⇒ same frozen copy, for the lifetime of that payload.
 */
export function readFrameDraft<T = unknown>(frame: Frame | null | undefined, toolId: string): T | null {
  const payload = frame?.drafts?.[toolId];
  if (!payload || typeof payload !== 'object') return null;
  const cached = readCache.get(payload);
  if (cached !== undefined) return cached as T | null;
  const codec = codecs.get(toolId);
  if (!codec) return null;
  const valid = codec.validate(payload);
  if (!valid) {
    readCache.set(payload, null);
    return null;
  }
  const copy = deepFreeze(clonePayload(toolId, valid));
  readCache.set(payload, copy);
  return copy as T;
}

/**
 * A FRESH mutable deep copy of the stored payload — the gesture-start
 * working clone. Never cached, never frozen: the tool owns this object for
 * the duration of the gesture and hands it back through `writeFrameDraft`.
 */
export function cloneFrameDraft<T = unknown>(frame: Frame | null | undefined, toolId: string): T | null {
  const payload = frame?.drafts?.[toolId];
  if (!payload || typeof payload !== 'object') return null;
  const codec = codecs.get(toolId);
  if (!codec) return null;
  const valid = codec.validate(payload);
  return valid ? (clonePayload(toolId, valid) as T) : null;
}

function clonePayload(toolId: string, payload: unknown): unknown {
  const codec = codecs.get(toolId);
  return codec?.clone ? codec.clone(payload) : structuredClone(payload);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// ─── R1b: replace-style write patch ────────────────────────────────────────────

/**
 * Builds the `Partial<Frame>` patch that stores `payload` (or removes the
 * entry when `payload` is null). Untouched keys keep their references, so an
 * unrelated tool's draft is never cloned or invalidated by a pen write — and
 * the Immer patch diff for a history step only ever names the one key that
 * actually changed.
 */
export function writeFrameDraft(frame: Frame, toolId: string, payload: unknown): Pick<Frame, 'drafts'> {
  const next: Record<string, unknown> = { ...(frame.drafts ?? {}) };
  if (payload === null || payload === undefined) delete next[toolId];
  else next[toolId] = payload;
  return { drafts: next };
}

// ─── Load-time sanitization ────────────────────────────────────────────────────

/**
 * Drops every drafts key this build cannot interpret: no codec registered,
 * or codec validation failed. Used by the document hydrator so a file saved
 * by a newer build loads with its unknown drafts evaporated instead of
 * carrying opaque data into the state tree. Returns undefined when nothing
 * survives, so the `drafts` key itself can be omitted.
 */
export function sanitizeFrameDrafts(drafts: unknown): Record<string, unknown> | undefined {
  if (!drafts || typeof drafts !== 'object' || Array.isArray(drafts)) return undefined;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(drafts as Record<string, unknown>)) {
    const codec = codecs.get(key);
    if (!codec || !value || typeof value !== 'object') continue;
    if (!codec.validate(value)) continue;
    kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

// ─── React consumption ─────────────────────────────────────────────────────────

/**
 * React-side draft reader. Memoized on the frame identity, so an unrelated
 * re-render hands back the SAME frozen copy (R1a cache makes this cheap)
 * and only a real draft swap (undo/redo/write) produces a new object —
 * downstream useMemo/useEffect dependency arrays behave like any other
 * piece of document state.
 */
export function useFrameDraft<T = unknown>(frame: Frame | null | undefined, toolId: string): T | null {
  return useMemo(() => readFrameDraft<T>(frame, toolId), [frame, toolId]);
}
