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

'use client';

import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { SourceFormat, ColorSpaceId } from '@opengpex/editor/core/files/types';
import { INGEST_DECISION_RULES } from '@opengpex/editor/core/files/strategy/engine/rules';
import { matchesRule } from '@opengpex/editor/core/files/strategy/engine/matcher';
import type { DecisionRule, NormalizedMatchContext } from '@opengpex/editor/core/files/strategy/engine/types';
import { formatMatchPattern, patternAdmits, cycleColumnSort, compareCellText, useRowPin, rowPinClass } from './shared';
import type { ColumnSort } from './shared';

const FORMAT_OPTIONS: SourceFormat[] = ['jpeg', 'png', 'webp', 'avif', 'heic', 'tiff', 'raw', 'bmp', 'gif', 'svg', 'eps', 'unknown'];
const DEPTH_OPTIONS: number[] = [1, 2, 4, 8, 10, 12, 14, 16, 32];
const COLORSPACE_OPTIONS: ColorSpaceId[] = ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'rec2020', 'cmyk', 'grayscale', 'unknown'];
const TRANSFER_OPTIONS = ['unset', 'pq', 'hlg'] as const;
/** Filter sentinel for the absent context value (undefined = the SDR/absent seam). */
type TransferFilter = 'pq' | 'hlg' | undefined | 'any' | 'unset';
/** Tri-state boolean axis: undefined = the engine's absent-context case. */
type BoolAxis = boolean | undefined | 'any';

type Axis<T> = T | 'any';

interface IngestFilters {
  format: Axis<SourceFormat>;
  bitDepth: Axis<number>;
  colorSpace: Axis<ColorSpaceId>;
  isMultiFrame: BoolAxis;
  hevcHardDecode: BoolAxis;
  transfer: TransferFilter;
  hasGainmap: Axis<boolean>;
}

const DEFAULT_FILTERS: IngestFilters = {
  format: 'any',
  bitDepth: 'any',
  colorSpace: 'any',
  isMultiFrame: 'any',
  hevcHardDecode: 'any',
  transfer: 'any',
  hasGainmap: 'any',
};

/**
 * Boolean-axis filter normalization: the engine context never carries `false`
 * (absent = the negative state), so a filter set to F means "the axis is
 * undeclared on the rule / undefined in the context" — folded to undefined
 * before any pattern test.
 */
function boolFilter(v: BoolAxis): true | undefined | 'any' {
  if (v === 'any') return 'any';
  return v === true ? true : undefined;
}

/** Rows visible under the active filters: every concrete axis must admit the rule. */
function rulePassesFilters(rule: DecisionRule, f: IngestFilters): boolean {
  const { condition } = rule;
  if (f.format !== 'any' && !patternAdmits(condition.format, f.format)) return false;
  if (f.bitDepth !== 'any' && !patternAdmits(condition.bitDepth, f.bitDepth)) return false;
  if (f.colorSpace !== 'any' && !patternAdmits(condition.colorSpace, f.colorSpace)) return false;
  if (f.isMultiFrame !== 'any' && !patternAdmits(condition.isMultiFrame, boolFilter(f.isMultiFrame))) return false;
  if (f.hevcHardDecode !== 'any' && !patternAdmits(condition.hevcHardDecode, boolFilter(f.hevcHardDecode))) return false;
  if (f.transfer !== 'any' && !patternAdmits(condition.transfer, f.transfer)) return false;
  if (f.hasGainmap !== 'any' && !patternAdmits(condition.hasGainmap, boolFilter(f.hasGainmap as BoolAxis))) return false;
  return true;
}

/** Colored T/F glyph used by the flag and retain cells. */
function TF({ v }: { v: boolean }) {
  return <span className={v ? 'text-emerald-500 font-bold' : 'text-rose-500 font-bold'}>{v ? 'T' : 'F'}</span>;
}

/**
 * One admission flag's text: undefined (undeclared, value-equality silence)
 * → omitted; '*' (declared wildcard) → 'any'; a boolean → 'T'/'F'.
 */
function flagText(name: string, pattern: unknown, absent: 'omit' | 'false'): string | null {
  // For hevc/gainmap an undeclared field behaves as `false` at every call
  // site, so display it as F; isMultiFrame's absent case stays omitted.
  if (pattern === undefined) return absent === 'false' ? `${name}=F` : null;
  if (pattern === '*') return `${name}=any`;
  return `${name}=${pattern ? 'T' : 'F'}`;
}

/** Extra admission flags beyond the three main axes, e.g. 'hevc=T · gm=F'. */
function extraFlagsText(rule: DecisionRule): string {
  const { condition } = rule;
  // Axis relevance gating: hevcHardDecode is probed solely by the heic decode
  // branch, and only the jpeg (UltraHDR) / heic (Apple hdrgainmap) handlers
  // ever populate raw.hasGainmap — other formats omit both flags entirely.
  // The multi-frame axis only exists for gif (temporal sequence) and tiff
  // (multi-page); those two formats show an explicit F when undeclared,
  // everything else omits the flag.
  const isHeic = condition.format === 'heic';
  const hasGainmapAxis = condition.format === 'jpeg' || isHeic;
  const hasPagedAxis = condition.format === 'gif' || condition.format === 'tiff';
  const parts = [
    flagText('paged', condition.isMultiFrame, hasPagedAxis ? 'false' : 'omit'),
    isHeic ? flagText('hevc', condition.hevcHardDecode, 'false') : null,
    hasGainmapAxis ? flagText('gainmap', condition.hasGainmap, 'false') : null,
  ].filter((v): v is string => v !== null);
  return parts.join(' · ') || '—';
}

/** Colored render twin of flagText (sort stays on the plain text). */
function flagNode(key: string, name: string, pattern: unknown, absent: 'omit' | 'false'): React.ReactNode | null {
  if (pattern === undefined) return absent === 'false' ? <span key={key}>{name}=<TF v={false} /></span> : null;
  if (pattern === '*') return <span key={key}>{name}=any</span>;
  return <span key={key}>{name}=<TF v={pattern === true} /></span>;
}

/** Colored render twin of extraFlagsText (sort stays on the plain text). */
function extraFlagsNode(rule: DecisionRule): React.ReactNode {
  const { condition } = rule;
  const isHeic = condition.format === 'heic';
  const hasGainmapAxis = condition.format === 'jpeg' || isHeic;
  const hasPagedAxis = condition.format === 'gif' || condition.format === 'tiff';
  const nodes = [
    flagNode('paged', 'paged', condition.isMultiFrame, hasPagedAxis ? 'false' : 'omit'),
    isHeic ? flagNode('hevc', 'hevc', condition.hevcHardDecode, 'false') : null,
    hasGainmapAxis ? flagNode('gainmap', 'gainmap', condition.hasGainmap, 'false') : null,
  ].filter((v): v is React.ReactNode => v !== null);
  return nodes.length > 0
    ? nodes.reduce((acc, n) => <React.Fragment>{acc} · {n}</React.Fragment>)
    : '—';
}

function Select<T extends string | number>({
  value, onChange, options, anyLabel,
}: {
  value: Axis<T>;
  onChange: (v: Axis<T>) => void;
  options: readonly T[];
  anyLabel: string;
}) {
  return (
    <select
      value={String(value)}
      onChange={(e) => onChange(e.target.value === 'any' ? 'any' : (options.find((o) => String(o) === e.target.value) as T))}
      className="bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/10 rounded-md px-1 py-0.5 text-[10px] font-mono text-[var(--text-main)] outline-none cursor-pointer"
    >
      <option value="any">{anyLabel}</option>
      {options.map((o) => (
        <option key={String(o)} value={String(o)}>{String(o)}</option>
      ))}
    </select>
  );
}

function BoolSelect({ value, onChange, anyLabel, allowUnset = true }: {
  value: BoolAxis;
  onChange: (v: BoolAxis) => void;
  anyLabel: string;
  /** false = the engine context never carries undefined on this axis. */
  allowUnset?: boolean;
}) {
  const str = value === 'any' ? 'any' : value === undefined ? 'unset' : value ? '1' : '0';
  return (
    <select
      value={str}
      onChange={(e) => onChange(e.target.value === 'any' ? 'any' : e.target.value === 'unset' ? undefined : e.target.value === '1')}
      className="bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/10 rounded-md px-1 py-0.5 text-[10px] font-mono text-[var(--text-main)] outline-none cursor-pointer"
    >
      <option value="any">{anyLabel}</option>
      {allowUnset && <option value="unset">(unset)</option>}
      <option value="1">true</option>
      <option value="0">false</option>
    </select>
  );
}

const TH = 'px-1.5 py-1 text-left text-[9px] font-black uppercase tracking-wider text-[var(--text-muted)] whitespace-nowrap';
const TD = 'px-1.5 py-1 text-[10px] font-mono text-[var(--text-main)] whitespace-nowrap';

/** One table column: its sort key, displayed text, and cell renderer. */
interface RuleColumn {
  key: string;
  label: string;
  text: (rule: DecisionRule) => string;
  render?: (rule: DecisionRule) => React.ReactNode;
}

const RULE_COLUMNS: RuleColumn[] = [
  { key: 'id', label: 'id', text: (r) => String(r.id) },
  { key: 'format', label: 'format', text: (r) => formatMatchPattern(r.condition.format) },
  { key: 'depth', label: 'depth', text: (r) => formatMatchPattern(r.condition.bitDepth) },
  { key: 'colorSpace', label: 'colorSpace', text: (r) => formatMatchPattern(r.condition.colorSpace) },
  {
    key: 'transfer',
    label: 'transfer',
    // Keep '*' and undefined visually distinct: an explicit '*' is a declared
    // wildcard (rendered 'any' like the other axes), while an absent field is
    // the engine's default-admit silence (rendered '—').
    text: (r) => (r.condition.transfer === undefined ? '—' : formatMatchPattern(r.condition.transfer)),
  },
  { key: 'extra', label: 'extra', text: extraFlagsText, render: extraFlagsNode },
  {
    key: 'channel',
    label: 'channel',
    text: (r) => r.action.decodeChannel,
    // The fail-fast terminus reads as an alarm: color it red.
    render: (r) => (r.action.decodeChannel === 'unsupported'
      ? <span className="text-rose-500 font-bold">unsupported</span>
      : r.action.decodeChannel),
  },
  { key: 'trc', label: 'trc', text: (r) => r.action.trc ?? 'srgb-trc' },
  { key: 'dataFormat', label: 'dataFormat', text: (r) => r.action.dataFormat ?? '—' },
  { key: 'orient', label: 'orient', text: (r) => r.action.applyOrientation },
  {
    key: 'retain',
    label: 'retain',
    text: (r) => (r.action.decodeChannel === 'image-bitmap' ? 'F' : 'T'),
    render: (r) => <TF v={r.action.decodeChannel !== 'image-bitmap'} />,
  },
];

/**
 * Ingest strategy table: the complete declarative rule table rendered verbatim
 * from INGEST_DECISION_RULES, with an axis filter row. When every axis carries
 * a concrete value the table also evaluates the first-match-wins semantics:
 * the winning rule is highlighted green and earlier-priority rules it shadows
 * are flagged amber — row-order mistakes become visible at a glance.
 */
export function IngestSection() {
  const [filters, setFilters] = useState<IngestFilters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<ColumnSort | null>(null);
  // Cross-format rows (wildcard/multi-format conditions: CMYK conversion, the
  // vector family, the catch-all terminus) admit EVERY probed format, so they
  // would pollute any concrete-format filter; hidden unless asked for.
  const [showCrossFormat, setShowCrossFormat] = useState(false);
  const { hoverKey, pinnedKey, setHoverKey, togglePin } = useRowPin();

  const resolution = useMemo(() => {
    const complete =
      filters.format !== 'any' &&
      filters.bitDepth !== 'any' &&
      filters.colorSpace !== 'any' &&
      filters.isMultiFrame !== 'any' &&
      filters.hevcHardDecode !== 'any' &&
      filters.transfer !== 'any' &&
      filters.hasGainmap !== 'any';
    if (!complete) return null;
    const ctx: NormalizedMatchContext = {
      format: filters.format as SourceFormat,
      bitDepth: filters.bitDepth as number,
      colorSpace: filters.colorSpace as ColorSpaceId,
      // The completeness guard above excludes 'any'; the undefined sentinel is
      // the engine's own absent-context value. Boolean axes fold F to
      // undefined — the context never carries false.
      isMultiFrame: boolFilter(filters.isMultiFrame) as true | undefined,
      hevcHardDecode: boolFilter(filters.hevcHardDecode) as true | undefined,
      transfer: filters.transfer === 'unset' || filters.transfer === 'any' ? undefined : filters.transfer,
      hasGainmap: boolFilter(filters.hasGainmap as BoolAxis) as true | undefined,
    };
    let winnerId: string | number | null = null;
    const shadowedIds = new Set<string | number>();
    for (const rule of INGEST_DECISION_RULES) {
      if (!matchesRule(rule, ctx)) continue;
      if (winnerId === null) {
        winnerId = rule.id;
      } else if (rule.id !== '00') {
        // The '00' catch-all wildcard matches every context, so flagging it
        // shadowed would be constant noise on every resolution; the row still
        // renders normally in the table.
        shadowedIds.add(rule.id);
      }
    }
    return { ctx, winnerId, shadowedIds };
  }, [filters]);

  const visibleRules = useMemo(() => {
    const rows = INGEST_DECISION_RULES.filter((rule) => {
      if (!showCrossFormat) {
        const fmt = rule.condition.format;
        const crossFormat = fmt === '*' || (Array.isArray(fmt) && fmt.length > 1);
        if (crossFormat) return false;
      }
      return rulePassesFilters(rule, filters);
    });
    if (!sort) return rows;
    const column = RULE_COLUMNS.find((c) => c.key === sort.key);
    if (!column) return rows;
    return [...rows].sort((a, b) => compareCellText(column.text(a), column.text(b)) * sort.dir);
  }, [filters, sort, showCrossFormat]);

  const set = <K extends keyof IngestFilters>(key: K) => (v: IngestFilters[K]) =>
    setFilters((prev) => ({ ...prev, [key]: v }));

  return (
    <div className="flex flex-col gap-2 min-h-0">
      {/* Axis filter row */}
      <div className="flex flex-wrap items-center gap-1.5 flex-shrink-0">
        <span className="text-[9px] font-black uppercase tracking-widest text-[var(--text-muted)]">Probe</span>
        <Select value={filters.format} onChange={set('format')} options={FORMAT_OPTIONS} anyLabel="fmt:any" />
        <Select value={filters.bitDepth} onChange={set('bitDepth')} options={DEPTH_OPTIONS} anyLabel="depth:any" />
        <Select value={filters.colorSpace} onChange={set('colorSpace')} options={COLORSPACE_OPTIONS} anyLabel="cs:any" />
        <BoolSelect value={filters.isMultiFrame} onChange={set('isMultiFrame')} anyLabel="paged:any" />
        <BoolSelect value={filters.hevcHardDecode} onChange={set('hevcHardDecode')} anyLabel="hevc:any" />
        <Select value={filters.transfer ?? 'unset'} onChange={(v) => set('transfer')(v === 'unset' ? undefined : (v as TransferFilter))} options={TRANSFER_OPTIONS} anyLabel="trf:any" />
        {/* hasGainmap is ALWAYS a boolean in the engine context (raw flag defaults
            to false), so the impossible undefined state is not offered here. */}
        <BoolSelect value={filters.hasGainmap} onChange={(v) => set('hasGainmap')(v as Axis<boolean>)} anyLabel="gm:any" allowUnset={false} />
        <label className="flex items-center gap-1 ml-1 cursor-pointer select-none">
          <input type="checkbox" checked={showCrossFormat} onChange={(e) => setShowCrossFormat(e.target.checked)} className="accent-indigo-500 outline-none" />
          <span className="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">cross-format</span>
        </label>
      </div>
      <div className="text-[9px] text-[var(--text-muted)] flex-shrink-0">
        {resolution
          ? <>Winner <span className="text-emerald-500 font-bold">{String(resolution.winnerId)}</span>
            {resolution.shadowedIds.size > 0 && <> · shadowed: {Array.from(resolution.shadowedIds).map(String).join(', ')}</>}
          </> : 'Set every axis to a concrete value to mark the winning rule (first-match-wins).'}
        {' '}{visibleRules.length}/{INGEST_DECISION_RULES.length} rows shown.
      </div>

      {/* Strategy table */}
      <div className="overflow-auto custom-scrollbar min-h-0 flex-1 rounded-lg border border-[var(--border-subtle)] dark:border-white/[0.06]">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-[var(--bg-stage)] z-10">
            <tr className="border-b border-[var(--border-subtle)] dark:border-white/[0.08]">
              {RULE_COLUMNS.map((col) => {
                const active = sort?.key === col.key;
                return (
                  <th
                    key={col.key}
                    onClick={() => setSort((prev) => cycleColumnSort(prev, col.key))}
                    className={`${TH} cursor-pointer select-none hover:text-[var(--text-main)] ${active ? 'text-indigo-500' : ''}`}
                    title="Click to sort (asc → desc → off)"
                  >
                    <span className="inline-flex items-center gap-0.5">
                      {col.label}
                      {active && (sort?.dir === 1
                        ? <ChevronUp size={8} className="text-indigo-500" />
                        : <ChevronDown size={8} className="text-indigo-500" />)}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleRules.map((rule) => {
              const isWinner = resolution?.winnerId === rule.id;
              const isShadowed = resolution?.shadowedIds.has(rule.id) ?? false;
              const dimmed = resolution !== null && !isWinner && !isShadowed;
              return (
                <tr
                  key={String(rule.id)}
                  onMouseEnter={() => setHoverKey(String(rule.id))}
                  onMouseLeave={() => setHoverKey(null)}
                  onClick={() => togglePin(String(rule.id))}
                  className={`cursor-pointer border-b border-[var(--border-subtle)] dark:border-white/[0.04] transition-colors
                    ${isWinner ? 'bg-emerald-500/10' : isShadowed ? 'bg-amber-500/10' : dimmed ? 'opacity-35' : ''}
                    ${rowPinClass(String(rule.id), hoverKey, pinnedKey)}`}
                >
                  {RULE_COLUMNS.map((col) => {
                    if (col.key === 'id') {
                      return (
                        <td key={col.key} className={`${TD} font-bold ${isWinner ? 'text-emerald-500' : isShadowed ? 'text-amber-500' : ''}`}>
                          {String(rule.id)}{isShadowed && <span className="ml-1 text-[8px] uppercase">shadowed</span>}
                        </td>
                      );
                    }
                    const bold = col.key === 'channel';
                    return (
                      <td key={col.key} className={`${TD} ${bold ? 'font-bold' : ''}`}>
                        {col.render?.(rule) ?? col.text(rule)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
