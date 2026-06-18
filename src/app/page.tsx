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

import React, { Suspense } from "react";
import GPEX from "@opengpex/editor/workspace";

export const metadata = {
  title: "OpenGPEX - A Open-Source Graphics & Photo Editor",
  description: "Powerful, standalone web-based image editor.",
};

export default function RootEditorPage() {
  return (
    <div className="fixed inset-0 bg-zinc-50 dark:bg-zinc-950 overflow-hidden">
      <Suspense
        fallback={
          <div className="flex h-full w-full bg-zinc-50 dark:bg-zinc-950" />
        }
      >
        <GPEX />
      </Suspense>
    </div>
  );
}
