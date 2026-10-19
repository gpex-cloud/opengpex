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
 * Minimal first-match-wins rule evaluator for the declarative ingest engine.
 *
 * Zero dependencies, pure function. Each field of a `DecisionCondition` is
 * tested against the normalized context; a rule matches only when ALL fields
 * pass. Rules are evaluated in declaration order (priority = matrix row
 * order), and the first matching rule wins.
 *
 * @module core/files/strategy/engine/matcher
 */

import type { DecisionRule, MatchPattern, NormalizedMatchContext } from './types';

function testField<T>(pattern: MatchPattern<T> | undefined, value: T): boolean {
  // 2026-10-19 semantics: an UNDECLARED condition compares by VALUE equality —
  // an `undefined` pattern matches only an `undefined` context (the SDR case
  // for `transfer`), and any concrete pattern matches by strict equality.
  // '*' is the ONLY explicit wildcard; there is no implicit any.
  if (pattern === '*') return true;
  if (typeof pattern === 'function') {
    return (pattern as (val: T) => boolean)(value);
  }
  if (Array.isArray(pattern)) {
    return (pattern as readonly T[]).includes(value);
  }
  return pattern === value;
}

/**
 * Whether ONE rule's condition matches the context — the single-row form of the
 * first-match evaluator above. Exported so inspection tooling (strategy review
 * panels) can evaluate every row individually and distinguish the winning row
 * from earlier-priority rows it shadows, with semantics guaranteed identical to
 * {@link matchRule} by construction (matchRule IS a loop over this).
 */
export function matchesRule(rule: DecisionRule, ctx: NormalizedMatchContext): boolean {
  const { condition } = rule;
  return (
    testField(condition.format, ctx.format) &&
    testField(condition.bitDepth, ctx.bitDepth) &&
    testField(condition.colorSpace, ctx.colorSpace) &&
    testField(condition.isMultiFrame, ctx.isMultiFrame) &&
    testField(condition.hevcHardDecode, ctx.hevcHardDecode) &&
    testField(condition.transfer, ctx.transfer) &&
    testField(condition.hasGainmap, ctx.hasGainmap)
  );
}

export function matchRule(
  rules: readonly DecisionRule[],
  ctx: NormalizedMatchContext,
): DecisionRule {
  for (const rule of rules) {
    if (matchesRule(rule, ctx)) {
      return rule;
    }
  }
  // Rule '00' is theoretically the wildcard fallback; this guard is for type safety.
  throw new Error(`[DecisionEngine] No rule matched for input: ${JSON.stringify(ctx)}`);
}
