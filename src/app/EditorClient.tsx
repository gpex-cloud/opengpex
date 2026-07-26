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

import dynamic from "next/dynamic";

/**
 * Dynamic import with SSR disabled — the entire GPEX editor component tree
 * relies on browser-only APIs (Worker, Canvas, IndexedDB) and cannot be
 * meaningfully prerendered on the server during `next build`.
 */
const GPEX = dynamic(() => import("@opengpex/editor/workspace"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full bg-zinc-50 dark:bg-zinc-950" />
  ),
});

export default function EditorClient() {
  return <GPEX />;
}
