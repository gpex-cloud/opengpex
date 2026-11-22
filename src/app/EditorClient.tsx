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

import { useCallback, useSyncExternalStore } from "react";

import dynamic from "next/dynamic";

import GpuUnavailableHint from "@opengpex/editor/workspace/components/GpuUnavailableHint";
import { GpuDevice } from "@opengpex/editor/core/engine/gpu/device/GpuDevice";

/**
 * Dynamic import with SSR disabled — the entire GPEX editor component tree
 * relies on browser-only APIs (Worker, Canvas, IndexedDB) and cannot be
 * meaningfully prerendered on the server during `next build`.
 */
const GPEX = dynamic(() => import("@opengpex/editor/workspace"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-zinc-50 dark:bg-zinc-950 select-none">
      <span className="inline-flex items-center text-[10px] font-bold tracking-[0.25em] uppercase text-zinc-400 dark:text-zinc-600">
        <span>Loading OpenGPEX</span>
        <span className="inline-flex tracking-normal ml-0.5">
          <span className="animate-pulse" style={{ animationDuration: "1.2s" }}>.</span>
          <span className="animate-pulse" style={{ animationDuration: "1.2s", animationDelay: "200ms" }}>.</span>
          <span className="animate-pulse" style={{ animationDuration: "1.2s", animationDelay: "400ms" }}>.</span>
        </span>
      </span>
    </div>
  ),
});

/** No-op subscription: WebGPU availability never changes within a page
 *  lifetime, so the store has no external updates to forward. */
const subscribeToNothing = () => () => {};

export default function EditorClient() {
  // Client components are still server-rendered for the initial HTML, so a
  // bare `navigator.gpu` check here would branch on a server/client boundary
  // (the server has no navigator) and break hydration. useSyncExternalStore
  // is the hydration-safe way to read a client-only value: during hydration
  // React renders with the server snapshot (supported = true, matching the
  // prerendered tree), then immediately re-checks the client snapshot and
  // re-renders to the hint when navigator.gpu is actually missing. No
  // hydration mismatch, no setState-in-effect cascade.
  const gpuSupported = useSyncExternalStore(
    subscribeToNothing,
    useCallback(() => GpuDevice.isSupported(), []),
    () => true,
  );

  // Detection layer 1 (S1 — navigator.gpu missing): the synchronous, free
  // capability probe. When unsupported we render the hint page instead of
  // the editor bundle. Hint only, per product decision — no fallback, no
  // flow interception.
  if (!gpuSupported) {
    return <GpuUnavailableHint variant="fullscreen" />;
  }
  return <GPEX />;
}
