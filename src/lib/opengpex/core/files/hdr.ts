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
 * hdr.ts — "does this document carry HDR content" — the ONE judgement the
 * per-document HDR presentation switch auto-defaults from.
 *
 * Consumers: CanvasStage (surface mode default), FrameInfoPanel (HDR badge +
 * toggle visibility) and the egest HDR-container lanes (WYSIWYG: the panel and
 * the exported file must agree on HDR semantics). This is a PRESENTATION
 * judgement about the source FILE only — it never inspects pixel buffers
 * (those always hold the unbounded scene-referred truth) and never decides the
 * working space (the engine invariant owns that).
 */

import type { ImageMetadata } from './types';

/**
 * True when the imported file itself advertises HDR:
 * - an Apple/ UltraHDR-style gain-map auxiliary image (`raw.hasGainmap`,
 *   parsed by the HEIC container reader);
 * - a PQ/HLG transfer characteristic recorded by the container metadata
 *   (`raw.transfer`, populated by the AVIF/HEIC HDR ingest lanes).
 */
export function fileCarriesHdr(meta?: ImageMetadata): boolean {
  if (!meta) return false;
  if (meta.raw?.hasGainmap) return true;
  return meta.raw?.transfer === 'pq' || meta.raw?.transfer === 'hlg';
}
