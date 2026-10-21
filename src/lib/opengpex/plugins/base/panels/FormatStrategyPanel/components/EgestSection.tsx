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
import type { GamutId } from '@opengpex/editor/core/types';
import type { SourceFormat } from '@opengpex/editor/core/files/types';
import { FORMAT_EGEST_CAPABILITIES } from '@opengpex/editor/core/files/strategy/engine/egest/capabilities';
import { resolveEgestDecision } from '@opengpex/editor/core/files/strategy/egest';
import { cycleColumnSort, compareCellText, useRowPin, rowPinClass } from './shared';
import type { ColumnSort } from './shared';

const FORMAT_KEYS = Object.keys(FORMAT_EGEST_CAPABILITIES) as SourceFormat[];
const GAMUT_OPTIONS: GamutId[] = ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'rec2020'];

const TH = 'px-1.5 py-1 text-left text-[9px] font-black uppercase tracking-wider text-[var(--text-muted)] whitespace-nowrap';
const TD = 'px-1.5 py-1 text-[10px] font-mono text-[var(--text-main)] whitespace-nowrap';

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-1">
      <span className="text-[9px] font-black uppercase tracking-widest text-[var(--text-muted)]">{label}</span>
      {children}
    </label>
  );
}

const selectCls = 'bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/10 rounded-md px-1 py-0.5 text-[10px] font-mono text-[var(--text-main)] outline-none cursor-pointer';

/** One capability-table column: sort key, label, cell text. */
const CAPABILITY_COLUMNS = [
  { key: 'format', label: 'format', text: (fmt: SourceFormat) => fmt },
  {
    key: 'channels',
    label: 'channels',
    text: (fmt: SourceFormat) => {
      const cap = FORMAT_EGEST_CAPABILITIES[fmt];
      return cap.supportedChannels.length === 0 ? '— (decode only)' : cap.supportedChannels.join(', ');
    },
  },
  { key: 'max depth', label: 'max depth', text: (fmt: SourceFormat) => String(FORMAT_EGEST_CAPABILITIES[fmt].maxBitDepth) },
  { key: 'gamut envelope', label: 'gamut envelope', text: (fmt: SourceFormat) => FORMAT_EGEST_CAPABILITIES[fmt].supportedGamuts.join(', ') },
  { key: 'icc', label: 'icc', text: (fmt: SourceFormat) => (FORMAT_EGEST_CAPABILITIES[fmt].supportsIccEmbed ? 'yes' : 'no') },
];

/**
 * Egest strategy view: the container capability map (rendered verbatim from
 * FORMAT_EGEST_CAPABILITIES) plus a live resolver — pick a request shape and
 * the real resolveEgestDecision answers with the actual lane / gamut / depth /
 * ICC / pass-through outcome. Decode-only formats throw in the solver, which
 * is the honest display (a caller bug, never a degrade-able edge).
 */
const ENCODABLE_FORMATS = FORMAT_KEYS.filter((f) => FORMAT_EGEST_CAPABILITIES[f].supportedChannels.length > 0);

export function EgestSection() {
  // The SOURCE document's format and the EXPORT target format are independent
  // axes: pass-through requires them to match, and decode-only formats (heic/
  // raw) are legal sources with no encoder.
  const [srcFormat, setSrcFormat] = useState<SourceFormat>('jpeg');
  const [format, setFormat] = useState<SourceFormat>('png');
  const [sourceGamut, setSourceGamut] = useState<GamutId>('adobe-rgb');
  const [requestedGamut, setRequestedGamut] = useState<GamutId | 'follow'>('follow');
  const [bitDepth, setBitDepth] = useState<8 | 16 | 'follow'>('follow');
  // The document's own bit depth (StoredAsset.bitDepth — full domain 8/10/12/
  // 14/16/32). The real UI folds it once (`docBitDepth > 8 ⇒ default 16,
  // else 8`), so the resolver replays exactly that mapping.
  const [docBitDepth, setDocBitDepth] = useState<number>(8);
  const [hdrSemantics, setHdrSemantics] = useState(false);
  // User ICC embed toggle: 'default' = no override (format default applies).
  const [iccOverride, setIccOverride] = useState<'default' | boolean>('default');
  const [sort, setSort] = useState<ColumnSort | null>(null);
  const { hoverKey, pinnedKey, setHoverKey, togglePin } = useRowPin();

  const sortedFormatKeys = useMemo(() => {
    if (!sort) return FORMAT_KEYS;
    const column = CAPABILITY_COLUMNS.find((c) => c.key === sort.key);
    if (!column) return FORMAT_KEYS;
    return [...FORMAT_KEYS].sort((a, b) => compareCellText(column.text(a), column.text(b)) * sort.dir);
  }, [sort]);

  const decision = useMemo(() => {
    try {
      return {
        ok: true as const,
        value: resolveEgestDecision({
          format,
          sourceGamut,
          requestedGamut: requestedGamut === 'follow' ? undefined : requestedGamut,
          sourceBitDepth: docBitDepth,
          requestedBitDepth: bitDepth === 'follow' ? undefined : bitDepth,
          hdrSemantics,
          embedIccOverride: iccOverride === 'default' ? undefined : iccOverride,
        }),
      };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [format, sourceGamut, requestedGamut, bitDepth, docBitDepth, hdrSemantics, iccOverride]);

  return (
    <div className="flex flex-col gap-3 min-h-0 overflow-y-auto custom-scrollbar">
      {/* Capability map */}
      <div className="rounded-lg border border-[var(--border-subtle)] dark:border-white/[0.06] overflow-hidden flex-shrink-0">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-[var(--border-subtle)] dark:border-white/[0.08] bg-[var(--bg-stage)]">
              {CAPABILITY_COLUMNS.map((col) => {
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
            {sortedFormatKeys.map((fmt) => {
              const cap = FORMAT_EGEST_CAPABILITIES[fmt];
              const dead = cap.supportedChannels.length === 0;
              return (
                <tr
                  key={fmt}
                  onMouseEnter={() => setHoverKey(fmt)}
                  onMouseLeave={() => setHoverKey(null)}
                  onClick={() => togglePin(fmt)}
                  className={`cursor-pointer border-b border-[var(--border-subtle)] dark:border-white/[0.04] transition-colors ${dead ? 'opacity-50' : ''} ${rowPinClass(fmt, hoverKey, pinnedKey)}`}
                >
                  {CAPABILITY_COLUMNS.map((col) => (
                    <td key={col.key} className={`${TD} ${col.key === 'format' ? 'font-bold' : ''}`}>{col.text(fmt)}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Live resolver */}
      <div className="flex-shrink-0">
        <div className="text-[9px] font-black uppercase tracking-widest text-[var(--text-muted)] mb-1.5">Decision Resolver</div>
        {/* Row 1 — the SOURCE document being exported (read-only facts) */}
        <div className="flex flex-wrap items-center gap-2 mb-1.5">
          <span className="text-[8px] font-black uppercase tracking-widest text-emerald-500/80 w-10">source</span>
          <Labeled label="src fmt">
            <select value={srcFormat} onChange={(e) => setSrcFormat(e.target.value as SourceFormat)} className={selectCls}>
              {FORMAT_KEYS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </Labeled>
          <Labeled label="src depth">
            <select value={docBitDepth} onChange={(e) => setDocBitDepth(Number(e.target.value))} className={selectCls}>
              {[8, 10, 12, 14, 16, 32].map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Labeled>
          <Labeled label="src gamut">
            <select value={sourceGamut} onChange={(e) => setSourceGamut(e.target.value as GamutId)} className={selectCls}>
              {GAMUT_OPTIONS.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </Labeled>
          <Labeled label="hdr">
            <input
              type="checkbox"
              checked={hdrSemantics}
              onChange={(e) => setHdrSemantics(e.target.checked)}
              title="Document HDR switch: routes AVIF onto the raw-10 PQ lane, arms the JPEG UltraHDR lane, and keeps EXR headroom unclamped"
              className="accent-indigo-500 outline-none cursor-pointer"
            />
          </Labeled>
        </div>
        {/* Row 2 — the EXPORT configuration (user intent) */}
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="text-[8px] font-black uppercase tracking-widest text-indigo-500/80 w-10">export</span>
          <Labeled label="exp fmt">
            <select value={format} onChange={(e) => setFormat(e.target.value as SourceFormat)} className={selectCls}>
              {ENCODABLE_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </Labeled>
          <Labeled label="req gamut">
            <select value={requestedGamut} onChange={(e) => setRequestedGamut(e.target.value === 'follow' ? 'follow' : (e.target.value as GamutId))} className={selectCls}>
              <option value="follow">(follow source)</option>
              {GAMUT_OPTIONS.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </Labeled>
          <Labeled label="req depth">
            <select value={String(bitDepth)} onChange={(e) => setBitDepth(e.target.value === 'follow' ? 'follow' : (Number(e.target.value) as 8 | 16))} className={selectCls}>
              <option value="follow">(follow src)</option>
              <option value="8">8</option>
              <option value="16">16</option>
            </select>
          </Labeled>
          <Labeled label="icc">
            <select
              value={String(iccOverride)}
              onChange={(e) => setIccOverride(e.target.value === 'default' ? 'default' : e.target.value === 'true')}
              title="embedIccOverride: user toggle over the format's ICC default"
              className={selectCls}
            >
              <option value="default">(format default)</option>
              <option value="true">on</option>
              <option value="false">off</option>
            </select>
          </Labeled>
        </div>
        <div className="text-[8px] text-[var(--text-muted)] mb-2">
          Pass-through ships the original bytes only when, besides the colour half above: no region, no resize,
          history unedited, source format matches the export format, and the source blob is retained.
        </div>
        {decision.ok ? (
          <div className="grid grid-cols-2 gap-1.5">
            {[
              ['channel', decision.value.channel],
              ['targetGamut', decision.value.targetGamut],
              ['bitDepth', String(decision.value.bitDepth)],
              ['canvasColorSpace', decision.value.canvasColorSpace],
              ['embedIcc', String(decision.value.embedIcc)],
              ['pass-through (colour)', String(decision.value.gamutPassThroughEligible)],
              ['src=exp fmt', String(srcFormat === format)],
              ['requestedGamut', decision.value.requestedGamut],
              ['sourceGamut', decision.value.sourceGamut],
              [
                'ultraHDR lane',
                format === 'jpeg' && hdrSemantics && decision.value.channel === 'canvas-8'
                  ? 'armed (fires with a decodable source gain map)'
                  : '—',
              ],
            ].map(([k, v]) => (
              <div key={k} className="bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08] rounded-lg px-2 py-1.5 flex items-center justify-between gap-2">
                <span className="text-[8px] font-black uppercase tracking-widest text-[var(--text-muted)]">{k}</span>
                <span className="text-[10px] font-mono font-bold text-[var(--text-main)]">{v}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[10px] font-mono text-rose-500 bg-rose-500/10 border border-rose-500/20 rounded-lg px-2 py-1.5">
            {decision.error}
          </div>
        )}
      </div>
    </div>
  );
}
