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
 * Core Version Constants
 * 
 * CORE_VERSION automatically injected from version field in package.json (via next.config.ts env configuration).
 * Merely run `npm version patch/minor/major` when publishing; automatically synchronized during build, no manual maintenance needed.
 * 
 * Used for version compatibility check during plugin registration (manifest.requirements.coreVersion).
 */

export const CORE_VERSION = process.env.NEXT_PUBLIC_CORE_VERSION || '0.0.0';

/**
 * Lightweight SemVer version comparison tool
 * Supports >=x.y.z format version requirement expressions (covering the vast majority of plugin scenarios)
 * No external semver package introduced, zero dependencies.
 */
export function satisfiesCoreVersion(requirement: string): boolean {
  if (!requirement) return true;

  // Supported formats: ">=1.0.0", ">= 1.0.0", "^1.0.0", "1.0.0"
  const match = requirement.match(/^(?:\^|>=?)\s*(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    // Unparseable expressions -> pass (lenient mode, to avoid blocking valid plugins)
    return true;
  }

  const [, rMajStr, rMinStr, rPatchStr] = match;
  const rMaj = Number(rMajStr);
  const rMin = Number(rMinStr);
  const rPatch = Number(rPatchStr);

  const parts = CORE_VERSION.split('.');
  const cMaj = Number(parts[0]) || 0;
  const cMin = Number(parts[1]) || 0;
  const cPatch = Number(parts[2]) || 0;

  // For ^ (caret) semantics: backward compatible within the same major version
  if (requirement.startsWith('^')) {
    if (rMaj === 0) {
      // ^0.x.y semantics: compatible within the same minor version
      return cMaj === rMaj && cMin === rMin && cPatch >= rPatch;
    }
    return cMaj === rMaj && (cMin > rMin || (cMin === rMin && cPatch >= rPatch));
  }

  // For >= semantics: current version >= required version
  if (cMaj !== rMaj) return cMaj > rMaj;
  if (cMin !== rMin) return cMin > rMin;
  return cPatch >= rPatch;
}
