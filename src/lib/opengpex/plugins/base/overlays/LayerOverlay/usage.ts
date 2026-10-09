/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

'use client';

/**
 * usage.ts — LayerOverlay affordance registry: plugins DECLARE what they want
 * shown (outlines/gizmos for layer types, hover suppression); LayerOverlay
 * owns all POLICY (aggregation semantics, visibility, fast-sync tracking).
 *
 * Sources are registered once at module scope (id-deduped) and their
 * `resolve` runs as a PURE function of the interaction signals during
 * LayerOverlay's render — no per-frame React state, no cross-plugin signal
 * writes. Aggregation is called from `LayerOverlayContent`, which already
 * re-renders on any signal change via `useEditorState`.
 */

/** What one plugin wants from LayerOverlay for the current interaction state. */
export interface LayerOverlayUsage {
  /** Layer types whose outline + gizmo are force-shown (pre-edit handles). */
  gizmoTypes?: readonly string[];
  /** Suppress hover-driven outlines (passive hover + hover-on-active). */
  suppressHover?: boolean;
}

/** Read-only view passed to `resolve`. Signals are the editor's interaction signals. */
export interface LayerOverlayUsageContext {
  signals: Readonly<Record<string, unknown>>;
}

export interface LayerOverlayUsageSource {
  /** Namespace, e.g. 'text'. Registration with a duplicate id is ignored. */
  readonly id: string;
  /**
   * Pure function of the signals. Return null/undefined to claim nothing.
   * MUST NOT write signals, mutate state, or read React context — it runs
   * during LayerOverlay's render.
   */
  resolve(ctx: LayerOverlayUsageContext): LayerOverlayUsage | null | undefined;
}

const sources = new Map<string, LayerOverlayUsageSource>();

/**
 * Declare how a plugin wants LayerOverlay to behave. Idempotent per id
 * (re-registration with the same id replaces the previous source — safe
 * under HMR). Returns an unregister function.
 */
export function registerLayerOverlayUsage(source: LayerOverlayUsageSource): () => void {
  sources.set(source.id, source);
  return () => {
    if (sources.get(source.id) === source) sources.delete(source.id);
  };
}

/** Aggregated usage: gizmo types are a union, suppressHover is an OR. */
export interface AggregatedLayerOverlayUsage {
  gizmoTypes: ReadonlySet<string>;
  suppressHover: boolean;
}

/**
 * Aggregate every registered source against the current signals. Deterministic
 * order (registration order) keeps unions stable across renders.
 */
export function aggregateLayerOverlayUsage(ctx: LayerOverlayUsageContext): AggregatedLayerOverlayUsage {
  const gizmoTypes = new Set<string>();
  let suppressHover = false;
  for (const source of sources.values()) {
    let usage: LayerOverlayUsage | null | undefined;
    try {
      usage = source.resolve(ctx);
    } catch (err) {
      // A broken contributor must never take down the overlay.
      console.error(`[LayerOverlay] usage source "${source.id}" resolve() threw`, err);
      continue;
    }
    if (!usage) continue;
    for (const t of usage.gizmoTypes ?? []) gizmoTypes.add(t);
    if (usage.suppressHover) suppressHover = true;
  }
  return { gizmoTypes, suppressHover };
}

/** Test-only: drop every registered source. */
export function __resetLayerOverlayUsageForTests(): void {
  sources.clear();
}
