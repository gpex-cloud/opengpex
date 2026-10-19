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

import React, { useState } from "react";
import { FileSearch, ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { FancyButton } from "@opengpex/editor/widgets/FancyButton";
import { PopupPanel } from "@opengpex/editor/widgets/PopupPanel";
import FunctionTabs from "@opengpex/editor/widgets/FunctionTabs";
import { WORKING_GAMUT } from "@opengpex/editor/core/engine/color";
import { INGEST_DECISION_RULES } from "@opengpex/editor/core/files/strategy/engine/rules";
import { FORMAT_EGEST_CAPABILITIES } from "@opengpex/editor/core/files/strategy/engine/egest/capabilities";
import { useStrategyConfig } from "./hooks";
import { IngestSection } from "./components/IngestSection";
import { EgestSection } from "./components/EgestSection";

type StrategyTab = 'ingest' | 'egest';

const GAMUT_CHIPS: readonly string[] = ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'rec2020'];

/** Compact stat cell shared by the HUD view. */
function StatCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)] dark:border-white/[0.08]">
      <div className="text-[7px] font-black uppercase tracking-widest text-[var(--text-muted)] mb-1">{label}</div>
      <div className="text-sm font-mono text-[var(--text-main)] font-bold tabular-nums">
        {value}
        {sub && <span className="text-[8px] text-[var(--text-muted)] font-normal ml-1.5">{sub}</span>}
      </div>
    </div>
  );
}

/**
 * FormatStrategyComponent (Outer Controller):
 * subscribes to the enable config and renders the PopupPanel shell; the
 * strategy tables themselves are static derivations of the live decision
 * sources (INGEST_DECISION_RULES / FORMAT_EGEST_CAPABILITIES), so there is no
 * async metric fetching anywhere in this panel.
 */
export function FormatStrategyComponent() {
  const { isEnabled, toggleCmd } = useStrategyConfig();
  const [tab, setTab] = useState<StrategyTab>('ingest');

  if (!isEnabled) return null;

  const ingestRuleCount = INGEST_DECISION_RULES.length;
  const ingestChannelCount = new Set(INGEST_DECISION_RULES.map((r) => r.action.decodeChannel)).size;
  const formatKeys = Object.keys(FORMAT_EGEST_CAPABILITIES);
  const encodableCount = formatKeys.filter((f) => FORMAT_EGEST_CAPABILITIES[f as keyof typeof FORMAT_EGEST_CAPABILITIES].supportedChannels.length > 0).length;
  const egestChannelCount = new Set(
    formatKeys.flatMap((f) => FORMAT_EGEST_CAPABILITIES[f as keyof typeof FORMAT_EGEST_CAPABILITIES].supportedChannels),
  ).size;

  return (
    <PopupPanel
      isVisible={true}
      onClose={() => toggleCmd?.execute()}
      title="Format Strategy Inspector"
      subTitle="Ingest & Egest Decision Review"
      icon={<FileSearch size={14} />}
      status="STABLE"
      mode="responsive"
      size="sm"
      position="BR"
      closeOnOutsideClick={false}
    >
      {(isExpanded) => (
        <>
          {/* HUD MODE (Compact): headline stats only */}
          {!isExpanded ? (
            <div className="flex flex-col gap-3 p-5 font-sans text-[var(--text-muted)] select-none h-full">
              <div className="flex items-center gap-2 flex-shrink-0">
                <ArrowDownToLine size={8} className="text-indigo-500" />
                <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-widest">
                  Static Decision Truth
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 flex-shrink-0">
                <StatCell label="Ingest Rules" value={String(ingestRuleCount)} sub={`${ingestChannelCount} channels`} />
                <StatCell label="Egest Formats" value={String(encodableCount)} sub={`${egestChannelCount} lanes`} />
                <StatCell label="Working Gamut" value={WORKING_GAMUT} />
                <StatCell label="Formats Known" value={String(formatKeys.length)} sub="ingest+egest" />
              </div>
              <div className="flex-shrink-0">
                <div className="text-[7px] font-black uppercase tracking-widest text-[var(--text-muted)] mb-1">GAMUT VOCABULARY</div>
                <div className="flex flex-wrap gap-1">
                  {GAMUT_CHIPS.map((g) => (
                    <span key={g} className="text-[8px] font-mono px-1.5 py-0.5 rounded-md bg-[var(--bg-stage)] border border-[var(--border-subtle)] dark:border-white/[0.08] text-[var(--text-main)]">
                      {g}{g === WORKING_GAMUT ? ' ★' : ''}
                    </span>
                  ))}
                </div>
              </div>
              <div className="pt-2 border-t border-[var(--border-subtle)] dark:border-t-white/[0.06] text-[8px] font-mono text-[var(--text-muted)] opacity-50 flex-shrink-0">
                Expand for the full strategy tables
              </div>
            </div>
          ) : (
            /* DASHBOARD MODE: FunctionTabs between the ingest and egest strategy tables */
            <div className="flex flex-col gap-2 h-full min-h-0 p-4 font-sans text-[var(--text-main)] select-none flex-1">
              <FunctionTabs<StrategyTab>
                value={tab}
                onChange={setTab}
                options={[
                  {
                    value: 'ingest',
                    label: `Ingest · ${ingestRuleCount}`,
                    icon: <ArrowDownToLine size={10} />,
                    tooltip: 'Import decision rule table (first-match-wins)',
                  },
                  {
                    value: 'egest',
                    label: 'Egest',
                    icon: <ArrowUpFromLine size={10} />,
                    tooltip: 'Export capability map + live decision resolver',
                  },
                ]}
              />
              <div className="flex-1 min-h-0 flex flex-col">
                {tab === 'ingest' ? <IngestSection /> : <EgestSection />}
              </div>
            </div>
          )}
        </>
      )}
    </PopupPanel>
  );
}

/**
 * Toolbar toggle button (TOOL_SETTINGS contribution), mirroring
 * StorageInfoSettings.
 */
export function FormatStrategySettings() {
  const { isEnabled, toggleCmd } = useStrategyConfig();

  return (
    <FancyButton
      iconOnly
      shape="rect"
      title="Format Strategy Inspector"
      active={isEnabled}
      onClick={() => toggleCmd?.execute()}
    >
      <FileSearch size={14} />
    </FancyButton>
  );
}
