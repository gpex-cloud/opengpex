/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

"use client";

import React, { useState } from "react";
import { ChevronDown, ChevronRight, ShieldAlert, ShieldCheck } from "lucide-react";
import type { IntegrityReport } from "../hooks/useIntegrityAudit";

interface IntegritySectionProps {
  report: IntegrityReport;
  /** Trace a finding row: receives the bare offending id for tree filtering. */
  onInvestigate: (id: string) => void;
}

/**
 * Strip a finding row down to its bare id: drops the "(x2)"/"(dangling)"
 * annotations and the "frameId → " prefix used for frame-scoped layer
 * findings.
 */
function investigateId(item: string): string {
  const bare = item.replace(/\s*\((?:x\d+|dangling)\)$/, "");
  const arrowIdx = bare.indexOf(" → ");
  return arrowIdx >= 0 ? bare.slice(arrowIdx + 3) : bare;
}

/**
 * IntegritySection: read-only structural audit card. Surfaces document-state
 * corruption (duplicated/dangling ids, legacy pre-fix frame ids) that would
 * otherwise only show up as React duplicate-key warnings. Diagnostics only —
 * there is deliberately no repair action here.
 */
export function IntegritySection({ report, onInvestigate }: IntegritySectionProps) {
  const [expanded, setExpanded] = useState(false);
  const ok = report.ok;

  return (
    <div
      className={`rounded-xl border overflow-hidden ${
        ok
          ? "border-emerald-500/20 bg-emerald-500/[0.04]"
          : "border-amber-500/30 bg-amber-500/[0.05]"
      }`}
    >
      <div
        className={`flex items-center justify-between px-3 py-2 ${!ok ? "cursor-pointer" : ""}`}
        onClick={() => !ok && setExpanded((prev) => !prev)}
      >
        <div className="flex items-center gap-2 min-w-0">
          {ok ? (
            <ShieldCheck size={12} className="text-emerald-500 flex-shrink-0" />
          ) : (
            <ShieldAlert size={12} className="text-amber-500 flex-shrink-0" />
          )}
          <span className="text-[9px] font-black uppercase tracking-widest text-[var(--text-main)]">
            Integrity Audit
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span
            className={`text-[8px] font-mono font-bold px-1.5 py-0.5 rounded ${
              ok
                ? "text-emerald-600 bg-emerald-500/10"
                : "text-amber-600 bg-amber-500/10"
            }`}
          >
            {ok ? "OK" : `${report.findings.length} issue${report.findings.length > 1 ? "s" : ""}`}
          </span>
          {!ok && (
            expanded ? (
              <ChevronDown size={11} className="text-[var(--text-muted)]" />
            ) : (
              <ChevronRight size={11} className="text-[var(--text-muted)]" />
            )
          )}
        </div>
      </div>

      {!ok && expanded && (
        <div className="px-3 pb-2 space-y-2">
          {report.findings.map((finding) => (
            <div key={finding.kind} className="space-y-0.5">
              <div className="text-[9px] font-bold text-amber-600 dark:text-amber-500">
                {finding.label} ({finding.items.length})
              </div>
              {finding.items.map((item, i) => (
                <div
                  key={`${finding.kind}:${i}`}
                  onClick={() => onInvestigate(investigateId(item))}
                  className="text-[8px] font-mono text-[var(--text-muted)] truncate pl-2 rounded cursor-pointer hover:text-[var(--text-main)] hover:bg-[var(--bg-stage)]"
                  title={`Click to trace "${investigateId(item)}" in the tree`}
                >
                  {item}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
