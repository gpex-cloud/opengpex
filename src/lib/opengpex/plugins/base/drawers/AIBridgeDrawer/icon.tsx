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

/**
 * AIBridgeIcon: Static sidebar icon.
 *
 * The busy/generating animation is now handled generically by DrawerBar via
 * the PluginService.isBusy() mechanism — no per-plugin animation code needed.
 *
 * Features a dollar-sign badge at the bottom-right corner to indicate
 * this is a paid/API-key-based service.
 */
export function AIBridgeIcon() {
  return (
    <span className="relative inline-flex items-baseline justify-center font-black leading-none translate-y-[2px]">
      <span className="text-[20px]">A</span>
      <span className="text-[18px]">i</span>
      {/* Dollar badge - small overlay at bottom-right, slightly overlapping */}
      <span className="absolute -top-[3px] -right-[4px] flex items-center justify-center w-[12px] h-[12px] rounded-full bg-emerald-600 text-white text-[12px] font-black leading-none shadow-sm border border-emerald-700/50">
        $
      </span>
    </span>
  );
}
