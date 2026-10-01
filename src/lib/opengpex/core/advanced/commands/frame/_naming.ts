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

import type { Frame, NormalizedState } from '@opengpex/editor/core/types';

/**
 * Frame/branch naming — helpers scoped to frame commands.
 */

/**
 * Compute a branch frame's `seqNum` + display name.
 *
 * @param activeFrame - The frame being branched from.
 * @param frames - Full frame store, used to count `activeFrame`'s existing branches.
 */
export function newBranchName(activeFrame: Frame, frames: NormalizedState<Frame>): { seqNum: string; fullName: string } {
  const siblingCount = frames.order.map(id => frames.byId[id]).filter(f => f.parentId === activeFrame.id).length;
  const nextIdx = siblingCount + 1;

  const seqNum = !activeFrame.parentId
    ? `Branch#${nextIdx}`
    : `${activeFrame.seqNum || 'Branch#?'}.${nextIdx}`;

  const rootName = activeFrame.name.split('__')[0];
  const fullName = `${rootName}__${seqNum}`;

  return { seqNum, fullName };
}

/**
 * Synthesize a `sourceFileName` for a derived (non-imported) frame, e.g.
 * `branchFromSelection`'s composite bake: `storeBundle` never writes a `raw:`
 * blob for it (there is no original file), so leaving `sourceFileName`
 * undefined would silently depend on `ImageInfoDrawer`'s
 * `sourceFileName || activeFrame.name` fallback instead of stating a name.
 *
 * Reuses the parent's original file base name (extension stripped) when known,
 * so a rename lineage stays readable across branches; falls back to the
 * branch's own `fullName` (`newBranchName`'s result) otherwise. The extension
 * is always `.png` — the composite's `displayBlob` really is PNG-encoded
 * (`core/engine/utils/pixel-utils.ts::canvasToBlob`'s default), independent of
 * `sourceFormat`'s inherited lineage tag.
 *
 * @param fullName - The branch's own display name, used when the parent has no file name.
 * @param parentSourceFileName - The parent frame's `metadata.sourceFileName`, if any.
 */
export function newBranchSourceFileName(fullName: string, parentSourceFileName?: string): string {
  const base = parentSourceFileName ? parentSourceFileName.replace(/\.[^./]+$/, '') : fullName;
  return `${base}.png`;
}

/**
 * Generate a new frame id: `f-<base36 timestamp>-<trunk|branch>`.
 *
 * @param hasParent - Whether this frame branches off another frame (vs. a fresh trunk import).
 */
export function newFrameId(hasParent: boolean): string {
  return `f-${Date.now().toString(36)}-${hasParent ? 'branch' : 'trunk'}`;
}

/**
 * Generate a unique group id shared by every frame of a multi-page import
 * (multi-page TIFF trunk+branch group, tagged into `frame.extra`). Mirrors the
 * `gifSequenceId` generation in `multi-gif.ts`.
 *
 * @param prefix - Group kind prefix, e.g. "tiff" → `tiff-grp-<base36 ts>-<rand>`.
 */
export function newMultiPageGroupId(prefix: string): string {
  return `${prefix}-grp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
