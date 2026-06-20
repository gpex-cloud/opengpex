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
import { Check, Copy } from "lucide-react";
import { ExifData } from "@opengpex/editor/core/types";
import FunctionButton from "@opengpex/editor/widgets/FunctionButton";

interface SourceFilePanelProps {
  fileName: string;
  fileFormat: string;
  fileSize: string;
  exif?: ExifData;
}

export function SourceFilePanel({
  fileName,
  fileFormat,
  fileSize,
  exif,
}: SourceFilePanelProps) {
  const [copied, setCopied] = React.useState(false);

  return (
    <div className="flex flex-col bg-[var(--bg-stage)] p-2.5 rounded-xl border border-[var(--border-subtle)] ">
      <div className="flex justify-between items-center mb-1">
        <div className="flex items-center gap-2">
          <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight">
            Source File
          </span>
          <FunctionButton
            onClick={() => {
              navigator.clipboard.writeText(fileName).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              });
            }}
            variant="ghost"
            className="w-5 h-5"
          >
            {copied ? (
              <Check size={10} className="text-emerald-500" />
            ) : (
              <Copy
                size={10}
                className="text-[var(--text-muted)] hover transition-colors"
              />
            )}
          </FunctionButton>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[8px] font-bold text-[var(--text-muted)] bg-[var(--bg-stage)] px-1.5 py-0.5 rounded shadow-sm border border-[var(--border-subtle)] uppercase">
            {fileFormat}
          </span>
          <span className="text-[8px] font-bold text-[var(--text-muted)] bg-[var(--bg-stage)] px-1.5 py-0.5 rounded shadow-sm border border-[var(--border-subtle)] uppercase">
            {fileSize}
          </span>
          {exif?.XResolution && (
            <span className="text-[8px] font-bold text-[var(--text-muted)] bg-[var(--bg-stage)] px-1.5 py-0.5 rounded shadow-sm border border-[var(--border-subtle)] uppercase">
              {exif.XResolution}{" "}
              {exif.ResolutionUnit === 2
                ? "PPI"
                : exif.ResolutionUnit === 3
                  ? "PPCM"
                  : "DPI"}
            </span>
          )}
        </div>
      </div>
      <span
        className="text-[11px] font-black text-indigo-400 truncate tracking-tight pt-0.5 pb-1"
        title={fileName}
      >
        {fileName}
      </span>
    </div>
  );
}
