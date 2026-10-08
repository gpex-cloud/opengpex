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

/**
 * ReleaseGuideCard — update guide modal shown when a new version is detected.
 *
 * Pure display component (no app-in-place hot update): offers a GitHub
 * Releases jump, one-click copy of Docker/source update commands, and a
 * per-version "skip" that suppresses future prompts for that version.
 */

import React, { useState } from 'react';
import { Rocket, X, Copy, Check, ExternalLink, CircleSlash } from 'lucide-react';
import type { UpdateInfo } from '@opengpex/editor/core/system/useUpdateChecker';
import { GITHUB_REPO_URL } from '@opengpex/editor/core/helpers/config';

const DOCKER_UPDATE_CMD = 'docker compose pull && docker compose up -d';
const SOURCE_UPDATE_CMD = 'git pull && pnpm install && pnpm build';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions/insecure context): keep silent.
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[9px] font-bold text-[var(--text-muted)] bg-[var(--bg-panel)] border border-[var(--border-subtle)] hover:text-amber-500 hover:border-amber-500/50 transition-colors"
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export default function ReleaseGuideCard({
  info,
  onClose,
  onSkipVersion,
}: {
  info: UpdateInfo;
  onClose: () => void;
  onSkipVersion: (version: string) => void;
}) {
  const releaseUrl = info.releaseUrl || `${GITHUB_REPO_URL}/releases`;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-zinc-950/50 backdrop-blur-sm px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-[var(--bg-panel)] border border-[var(--border-subtle)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-subtle)] bg-amber-500/5">
          <Rocket size={16} className="text-amber-500" />
          <span className="text-[12px] font-bold text-[var(--text-main)] flex-1">
            {info.isCritical
              ? 'Critical security update available!'
              : 'A new OpenGPEX version is available!'}
          </span>
          <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-amber-500/20 text-amber-500">
            v{info.latestVersion}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-stage)] transition-colors"
            aria-label="Close"
          >
            <X size={13} />
          </button>
        </div>

        <div className="flex flex-col gap-3 px-4 py-3">
          {/* Version transition */}
          <p className="text-[10px] text-[var(--text-muted)]">
            Current version:{' '}
            <span className="font-mono">v{info.currentVersion}</span>
            {'  →  '}
            Latest release:{' '}
            <span className="font-mono text-amber-500 font-semibold">
              v{info.latestVersion}
            </span>
          </p>

          {/* Release notice */}
          {info.notice && (
            <p className="text-[10px] text-[var(--text-main)] leading-relaxed">
              ✨ {info.notice}
            </p>
          )}

          {/* Recommended update commands */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest">
              Recommended update methods
            </span>
            <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-[8px] font-bold text-[var(--text-muted)] uppercase">
                  Docker
                </span>
                <code className="text-[9px] font-mono text-[var(--text-main)] truncate">
                  {DOCKER_UPDATE_CMD}
                </code>
              </div>
              <CopyButton text={DOCKER_UPDATE_CMD} />
            </div>
            <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-[8px] font-bold text-[var(--text-muted)] uppercase">
                  From source
                </span>
                <code className="text-[9px] font-mono text-[var(--text-main)] truncate">
                  {SOURCE_UPDATE_CMD}
                </code>
              </div>
              <CopyButton text={SOURCE_UPDATE_CMD} />
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <a
              href={releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-[10px] font-bold text-zinc-950 bg-amber-500 hover:bg-amber-400 transition-colors"
            >
              <ExternalLink size={12} />
              GitHub Releases
            </a>
            <button
              type="button"
              onClick={() => {
                if (info.latestVersion) onSkipVersion(info.latestVersion);
                onClose();
              }}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-[10px] font-bold text-[var(--text-muted)] bg-[var(--bg-stage)] border border-[var(--border-subtle)] hover:border-indigo-500/50 hover:text-indigo-500 transition-colors"
            >
              <CircleSlash size={12} />
              Skip this version
            </button>
          </div>
          <p className="text-[8px] text-[var(--text-muted)] opacity-60 text-center">
            Skipping suppresses prompts for v{info.latestVersion} only — newer
            versions will still notify you.
          </p>
        </div>
      </div>
    </div>
  );
}
