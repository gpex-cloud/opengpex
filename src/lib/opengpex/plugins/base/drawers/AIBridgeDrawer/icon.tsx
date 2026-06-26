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
 */
export function AIBridgeIcon() {
  return (
    <span className="font-black text-[14px] uppercase leading-none px-[2px]">
      AI
    </span>
  );
}
