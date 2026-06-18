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

import { ImagePlus } from "lucide-react";
import PluginSlot from "./PluginSlot";

export const LandingPage = () => (
  <div className="absolute inset-0 flex flex-col items-center justify-center p-12 text-center overflow-hidden">
    <div className="mb-8 relative lg:scale-125">
      <div className="absolute inset-0 bg-indigo-500/20 blur-3xl rounded-full translate-y-4" />
      <ImagePlus
        size={120}
        strokeWidth={1}
        className="relative text-indigo-500/30 "
      />
    </div>
    <div className="space-y-4 max-w-sm relative">
      <PluginSlot name="LANDING_PAGE">
        <h2 className="text-2xl font-black text-[var(--text-main)] tracking-tighter leading-none italic uppercase">
          A Clean Workspace
        </h2>
        <p className="text-[10px] font-black text-[var(--text-muted)] tracking-[0.2em] uppercase">
          Ready to start your next creative project?
        </p>
      </PluginSlot>
    </div>
  </div>
);
