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
 * Ingest binding of the shared first-match-wins decision table runtime.
 *
 * The evaluation semantics (field patterns, `'*'` as the only wildcard,
 * undeclared field = value equality against `undefined`, row order = priority)
 * live in `core/helpers/decision-table`. This module only fixes the ingest
 * context's field list and table name so call sites keep their two-argument
 * signatures.
 *
 * @module core/files/strategy/engine/matcher
 */

import {
  matchesRule as matchesTableRule,
  matchRule as matchTableRule,
} from '@opengpex/editor/core/helpers/decision-table';
import type { DecisionRule, NormalizedMatchContext } from './types';

/** Every ingest context field a rule condition is evaluated against. */
const INGEST_FIELDS: readonly (keyof NormalizedMatchContext)[] = [
  'format',
  'bitDepth',
  'colorSpace',
  'isMultiFrame',
  'hevcHardDecode',
  'transfer',
  'hasGainmap',
];

/**
 * Whether ONE rule's condition matches the context — the single-row form of
 * {@link matchRule}. Exported so inspection tooling (strategy review panels)
 * can evaluate every row individually and distinguish the winning row from
 * earlier-priority rows it shadows.
 */
export function matchesRule(rule: DecisionRule, ctx: NormalizedMatchContext): boolean {
  return matchesTableRule(rule, ctx, INGEST_FIELDS);
}

export function matchRule(
  rules: readonly DecisionRule[],
  ctx: NormalizedMatchContext,
): DecisionRule {
  return matchTableRule(rules, ctx, INGEST_FIELDS, 'ingest');
}
