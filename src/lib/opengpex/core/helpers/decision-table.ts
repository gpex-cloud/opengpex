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
 * Generic first-match-wins decision table runtime.
 *
 * Zero dependencies, pure functions. A table is an ordered list of rules; each
 * rule pairs a condition (one match pattern per context field) with an action
 * payload. Rules are evaluated in declaration order and the first rule whose
 * every field passes wins, so priority is simply row order.
 *
 * Field semantics (shared by every table):
 * - `'*'` is the ONLY wildcard.
 * - An UNDECLARED field compares by value equality against `undefined`, i.e.
 *   it admits only a context whose value for that field is also absent. There
 *   is no implicit "any" — a rule that wants to ignore a field must say `'*'`.
 * - An array admits any listed member; a function is a custom predicate; any
 *   other value is compared with strict equality.
 *
 * The field list is passed explicitly rather than read off the context object
 * or the condition: a context may omit a field (absent = undefined) and a
 * condition may omit a field (undeclared = must be undefined), so neither
 * object's own keys reliably enumerate everything that has to be checked.
 *
 * @module core/helpers/decision-table
 */

/** Matching pattern for one context field. */
export type MatchPattern<T> = T | readonly T[] | ((val: T) => boolean) | '*';

/** One condition: an optional pattern per context field. */
export type DecisionCondition<C> = { readonly [K in keyof C]?: MatchPattern<C[K]> };

/**
 * One table row. `id` is a stable label used for inspection and diagnostics.
 *
 * `Cond` defaults to the strict per-field condition derived from the context.
 * A table may supply a wider condition type (e.g. declaring `boolean` patterns
 * for a context field typed `true | undefined`); matching is a runtime value
 * comparison, so the width of the declared pattern type does not affect it.
 */
export interface DecisionRule<C, A, Cond = DecisionCondition<C>> {
  readonly id: number | string;
  readonly condition: Cond;
  readonly action: A;
}

/** Whether one field pattern admits a context value. */
export function testField<T>(pattern: MatchPattern<T> | undefined, value: T): boolean {
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
 * Whether ONE rule's condition matches the context over the given fields.
 * Exported so inspection tooling can evaluate rows individually (e.g. to tell
 * the winning row from earlier rows it shadows) with semantics identical to
 * {@link matchRule}, which is a loop over this.
 */
export function matchesRule<C, A, Cond>(
  rule: DecisionRule<C, A, Cond>,
  ctx: C,
  fields: readonly (keyof C)[],
): boolean {
  const condition = rule.condition as unknown as Partial<Record<keyof C, MatchPattern<unknown>>>;
  for (const field of fields) {
    if (!testField<unknown>(condition[field], ctx[field])) return false;
  }
  return true;
}

/**
 * First-match evaluation. Tables are expected to end with a catch-all row, so
 * a miss is a table-authoring defect and throws with the table name and input.
 */
export function matchRule<C, A, Cond>(
  rules: readonly DecisionRule<C, A, Cond>[],
  ctx: C,
  fields: readonly (keyof C)[],
  tableName: string,
): DecisionRule<C, A, Cond> {
  for (const rule of rules) {
    if (matchesRule(rule, ctx, fields)) return rule;
  }
  throw new Error(`[DecisionTable:${tableName}] No rule matched for input: ${JSON.stringify(ctx)}`);
}
