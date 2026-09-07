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
 * Skill registry — named experience templates for Agent planning.
 *
 * Skills are knowledge, not code. The LLM references a Skill's
 * recommended steps but can freely adjust based on the current
 * editor state (auto-injected [State] snapshot).
 *
 * **Adding a new Skill:** append one `AgentSkill` object to
 * `AGENT_SKILLS`. Everything else — the catalog injected into the
 * system prompt, the `get_skill` tool enum, and the detail lookup —
 * derives from this single array automatically.
 *
 * ## Future direction: Markdown-native skills
 *
 * The current structure uses typed fields (goal / prerequisites / steps /
 * successCriteria). This works but is somewhat rigid — Skill content is
 * consumed by the LLM, not by code, so a freeform Markdown string would
 * be a more natural fit.
 *
 * Planned migration path:
 *
 *   Phase 2 — Replace the four detail fields with a single `content: string`
 *   (Markdown). `getSkillDetail()` returns the raw Markdown; `get_skill`
 *   sends it directly as a tool result. The metadata fields (id / name /
 *   summary) stay typed because they are consumed by code (tool enum,
 *   system prompt catalog, future UI).
 *
 *   Phase 3 — Move each skill to a standalone `.md` file under `skills/`
 *   with YAML frontmatter for metadata. A build-time or runtime loader
 *   scans the directory and populates `AGENT_SKILLS`. This opens the door
 *   to community-contributed skills via simple `.md` file PRs — no
 *   TypeScript knowledge required.
 *
 *   Phase 4 — Online skill marketplace on gpex-cloud. Users create /
 *   share / import skills from the web. The editor fetches them via API.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A named experience template that the Agent can look up on demand.
 *
 * See "Future direction" above — the detail fields (goal, prerequisites,
 * steps, successCriteria) will eventually merge into a single `content`
 * Markdown string.
 */
export interface AgentSkill {
  /** Unique identifier used in `get_skill` tool calls. */
  id: string;
  /** Human-readable name (not sent to LLM in the catalog). */
  name: string;
  /** One-line summary for the system prompt catalog (~10 words). */
  summary: string;
  /** What this skill achieves — returned by `get_skill`. */
  goal: string;
  /** Conditions that should be true before starting. */
  prerequisites: string[];
  /** Recommended step sequence (LLM may skip/reorder based on state). */
  steps: string[];
  /** How to verify the skill completed successfully. */
  successCriteria: string[];
}

// ─── Skill Registry (single source of truth) ────────────────────────────────

export const AGENT_SKILLS: AgentSkill[] = [
  {
    id: 'bgremove_and_export',
    name: 'Background Remove and Export',
    summary: 'Remove the background and export the cut-out subject',
    goal: 'Remove the image background, leaving only the subject on a transparent canvas, then export it (PNG by default to preserve transparency; honor the user\'s format if they ask for one).',
    prerequisites: [
      'An image/frame is open in the editor',
      'The image has a distinguishable foreground subject',
    ],
    steps: [
      '1. Call remove_background — runs AI detection and creates a FOREGROUND selection (selects the subject)',
      '2. Call invert_selection — flips the selection to cover the BACKGROUND',
      '3. Call drill_selection — deletes the background pixels and exits clip mode',
      '4. If the user wants specific dimensions, call resize_image',
      '5. Call export_image — use format:"png" to preserve transparency (default), or the format the user requested',
    ],
    successCriteria: [
      'Background pixels are transparent (checkerboard pattern visible in editor)',
      'Foreground subject is intact and unaffected',
      'Image exported in the requested format (PNG by default)',
    ],
  },
];

// ─── Derived helpers (auto-sync with registry) ───────────────────────────────

/** All registered skill IDs — used for the `get_skill` tool enum. */
export const SKILL_IDS: string[] = AGENT_SKILLS.map((s) => s.id);

/**
 * Build the compact skill catalog for system prompt injection.
 * Only names + one-line summaries (~100 tokens total).
 * Returns empty string if no skills are registered.
 *
 * Example output:
 * ```
 * ## Available Skills
 * - bgremove_and_export: Remove background and export as transparent PNG
 * Use get_skill to retrieve detailed steps when the user's goal matches a skill.
 * ```
 */
export function getSkillCatalog(): string {
  if (AGENT_SKILLS.length === 0) return '';
  const lines = AGENT_SKILLS.map((s) => `- ${s.id}: ${s.summary}`);
  return [
    '## Available Skills',
    ...lines,
    'Use get_skill to retrieve detailed steps when the user\'s goal matches a skill.',
  ].join('\n');
}

/**
 * Get the detailed info for a skill by ID (returned by the `get_skill` tool).
 * Omits `summary` (already in the catalog) to save tokens.
 * Returns `null` if the skill ID is not found.
 */
export function getSkillDetail(skillId: string): Omit<AgentSkill, 'summary'> | null {
  const skill = AGENT_SKILLS.find((s) => s.id === skillId);
  if (!skill) return null;
  const { summary: _summary, ...detail } = skill;
  return detail;
}
