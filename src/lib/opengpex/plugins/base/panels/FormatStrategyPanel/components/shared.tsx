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
 * Pure display helpers for the FormatStrategyPanel: they turn the declarative
 * rule-table condition stubs (scalar / set / predicate / wildcard patterns)
 * into human-readable axis text, and evaluate one filter axis against one
 * condition pattern. All rendering decisions stay derived from the live rule
 * table — nothing here duplicates strategy knowledge.
 */

import { useEffect, useState } from 'react';
import type { MatchPattern } from '@opengpex/editor/core/files/strategy/engine/types';

/** Column sort state shared by the strategy tables. */
export interface ColumnSort {
  key: string;
  dir: 1 | -1;
}

/**
 * Row highlight state for the strategy tables: the row under the cursor is
 * gently highlighted while hovering, clicking a row pins a stronger highlight
 * (click again to unpin), and Escape clears the pin.
 */
export function useRowPin() {
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!pinnedKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinnedKey(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinnedKey]);

  return {
    hoverKey,
    pinnedKey,
    setHoverKey,
    togglePin: (key: string) => setPinnedKey((prev) => (prev === key ? null : key)),
  };
}

/**
 * Row classes for one highlight state. Hover is the weakest tier, the pin is
 * announced with an inset ring so it stays distinguishable from the semantic
 * winner (emerald) / shadowed (amber) row tints it may stack onto.
 */
export function rowPinClass(key: string, hoverKey: string | null, pinnedKey: string | null): string {
  if (pinnedKey === key) return 'bg-sky-500/15 ring-1 ring-inset ring-sky-500/40';
  if (hoverKey === key) return 'bg-white/[0.06] dark:bg-white/[0.04]';
  return '';
}

/**
 * Cycle the sort state for one column: none → ascending → descending → none.
 */
export function cycleColumnSort(current: ColumnSort | null, key: string): ColumnSort | null {
  if (!current || current.key !== key) return { key, dir: 1 };
  if (current.dir === 1) return { key, dir: -1 };
  return null;
}

/** Locale-aware comparison of two cell texts, digits compared numerically. */
export function compareCellText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** Bit depths probed when summarizing an unknown numeric predicate. */
const PREDICATE_PROBES = [1, 2, 4, 8, 10, 12, 14, 16, 32, 64];

/**
 * Human-readable text for one condition pattern.
 * - `'*'` / `undefined` → 'any'
 * - scalar → the value itself
 * - array → members joined with ' / '
 * - predicate → summarized by probing: a contiguous matching range collapses
 *   to '≥min' / 'min..max'; anything else falls back to 'custom'.
 */
export function formatMatchPattern(pattern: MatchPattern<unknown> | undefined): string {
  // Distinct displays for distinct semantics: an explicit '*' is the declared
  // wildcard ('any'), while an UNDECLARED field compares by value equality in
  // the engine matcher — it admits only an equally-absent context value, so it
  // renders as '—', never as 'any'.
  if (pattern === undefined) return '—';
  if (pattern === '*') return 'any';
  if (typeof pattern === 'function') return describeNumericPredicate(pattern as (v: number) => boolean);
  if (Array.isArray(pattern)) return pattern.map(String).join(' / ');
  return String(pattern);
}

/**
 * Summarize a numeric predicate by probing a fixed depth ladder. The rule
 * table only ever declares `d >= N`-shaped predicates, so a contiguous match
 * from some probe onward renders as '≥N'; a bounded contiguous range renders
 * as 'min..max'. Genuine one-off predicates degrade honestly to 'custom'.
 */
function describeNumericPredicate(fn: (v: number) => boolean): string {
  const matched = PREDICATE_PROBES.filter((d) => fn(d));
  if (matched.length === 0) return 'custom';
  const idxs = matched.map((d) => PREDICATE_PROBES.indexOf(d));
  const contiguous = idxs.every((idx, i) => i === 0 || idx === idxs[i - 1] + 1);
  if (!contiguous) return 'custom';
  const min = matched[0];
  const max = matched[matched.length - 1];
  if (matched.length === 1) return `=${min}`;
  if (max === PREDICATE_PROBES[PREDICATE_PROBES.length - 1]) return `≥${min}`;
  return `${min}..${max}`;
}

/**
 * Whether one condition pattern admits the filter value — the same semantics
 * as the engine matcher's per-field test (`'*'`/undefined admit everything,
 * then predicate → array → scalar), applied to a single axis so the strategy
 * table can filter rows without dragging in the first-match evaluator.
 */
export function patternAdmits(pattern: MatchPattern<unknown> | undefined, value: unknown): boolean {
  // Mirrors the engine matcher's per-field test: '*' is the only wildcard; an
  // undeclared pattern matches only an equally-undefined value.
  if (pattern === '*') return true;
  if (pattern === undefined) return value === undefined;
  if (typeof pattern === 'function') return (pattern as (v: unknown) => boolean)(value);
  if (Array.isArray(pattern)) return (pattern as unknown[]).includes(value);
  return pattern === value;
}
