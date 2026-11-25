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
 * The neutral umbrella for engine-side plugin slots (`contributions.engine`).
 *
 * LOCATION CONTRACT: this interface is OWNERSHIP-NEUTRAL — it only aggregates
 * the per-slot contracts and must NOT host any slot's anchor here. Each slot's
 * anchor interface + registry live next to the engine module that CONSUMES it
 * (`translators/vector.ts` owns vectorSource; future slots get their own
 * anchor modules). A new slot = new anchor module + one field here, never a
 * new section inside someone else's implementation file.
 */

import type { VectorSourceContributor } from './translators/vector';

export interface EngineContribution {
  /** Vector-tool translators (brush/pen/text/markers → engine sources). */
  readonly vectorSource?: VectorSourceContributor;
}
