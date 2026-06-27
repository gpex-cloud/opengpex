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

import React from "react";
import { Zap, Cpu, ShieldCheck, AlertCircle } from "lucide-react";
import { EngineStatus } from "@opengpex/editor/core/types";

interface ImagingEnginesPanelProps {
  engineStatuses: EngineStatus[];
  show: boolean;
}

export function ImagingEnginesPanel({
  engineStatuses,
  show,
}: ImagingEnginesPanelProps) {
  if (!show) return null;

  return (
    <div className="pt-2">
      <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-widest mb-2 block">
        Imaging Engines
      </span>
      <div className="space-y-1">
        {engineStatuses.map((engine: EngineStatus) => (
          <div
            key={engine.id}
            className="flex items-center justify-between bg-[var(--bg-stage)] p-2 rounded-xl border border-[var(--border-subtle)] group/engine"
          >
            <div className="flex items-center gap-2">
              <div
                className={`w-6 h-6 rounded-lg flex items-center justify-center ${
                  engine.status === "ready"
                    ? "bg-emerald-500/10 text-emerald-500"
                    : engine.status === "unimplemented"
                      ? "bg-[var(--bg-stage)]0/10 text-[var(--text-muted)]"
                      : "bg-rose-500/10 text-rose-500"
                }`}
              >
                {engine.id.includes("wasm") ? (
                  <Zap size={12} />
                ) : (
                  <Cpu size={12} />
                )}
              </div>
              <div className="flex flex-col">
                <span className="text-[9px] font-black text-[var(--text-main)] uppercase tracking-tighter leading-none">
                  {engine.name}
                </span>
                <span className="text-[7px] font-bold text-[var(--text-muted)] uppercase italic leading-tight">
                  {engine.id}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <span
                className={`text-[7px] font-black uppercase px-1.5 py-0.5 rounded ${
                  engine.status === "ready"
                    ? "bg-emerald-500/10 text-emerald-500"
                    : "bg-rose-500/10 text-rose-500"
                }`}
              >
                {engine.status}
              </span>
              {engine.status === "ready" && (
                <ShieldCheck size={10} className="text-emerald-500" />
              )}
              {engine.status === "error" && (
                <AlertCircle size={10} className="text-rose-500" />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
