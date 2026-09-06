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
 * Model modality classification — deliberately decoupled from providers.
 *
 * Modality answers "what can this model do?" and is inferred from either
 * structured capability data (when a provider exposes it, e.g. LocalAI's
 * /v1/models/capabilities) or, as a fallback, from naming patterns.
 *
 * Modality NEVER blocks an action. It only drives the badge shown next to a
 * model name plus a soft hint — the server is the authority on what actually
 * works, so a mis-guessed label must not stop the user from trying.
 */

/** What a model can do:
 *  - `image`   text→image generation only (DALL-E, FLUX, SDXL…)
 *  - `text`    text→text chat only (GPT-4o, Llama, plain Qwen…)
 *  - `multi`   accepts images (vision) and/or produces both text and images
 *  - `unknown` could not be determined — a legal, non-blocking state */
export type ModelModality = 'text' | 'image' | 'multi' | 'unknown';

/**
 * Name-pattern hints, evaluated top to bottom (first match wins).
 * Extend this table freely — it is the single place where naming heuristics live.
 */
export const MODALITY_HINTS: Array<{ match: RegExp; modality: ModelModality }> = [
  // ── image: text-to-image generators. Checked before the multi/text rules so
  //    that a generator whose family name also matches a chat rule (e.g.
  //    "grok-imagine-image", "gemini-*-image") is not misread as conversational.
  { match: /gpt-image|dall-?e|flux|sd[^a-z]|sd$|stable-?diffusion|sdxl|kolors|wanx|imagen|t2i|playground-v|kandinsky|pixart|-image(?:[-.\d]|$)|imagine-image/i, modality: 'image' },

  // ── multi: vision / any-to-any models. Before the text rules so "qwen-vl" is
  //    not swallowed by the generic "qwen" rule.
  { match: /-vl|vl-|vision|visual|omni|multimodal|any-?to-?any|llava|moondream|bakllava|pixtral|idefics/i, modality: 'multi' },
  { match: /gemini-[\d.]+-(pro|flash)/i, modality: 'multi' },
  // Grok's flagship chat models accept images
  { match: /^grok-[\d.]/i, modality: 'multi' },

  // ── text: chat / completion models ──
  { match: /gpt-[45o]|gpt-oss|^o[134]|qwen|llama|mistral|mixtral|claude|deepseek|yi-|chatglm|gemma|phi-|command-r|nemotron|grok/i, modality: 'text' },
];

/**
 * Infers a model's modality from its ID alone.
 * Provider-agnostic by design: the same model ID means the same thing no matter
 * which gateway serves it.
 */
export function inferModality(modelId: string): ModelModality {
  if (!modelId) return 'unknown';
  for (const entry of MODALITY_HINTS) {
    if (entry.match.test(modelId)) return entry.modality;
  }
  return 'unknown';
}

/** Structured capability payload some providers expose (LocalAI-style). */
export interface ModelCapabilityHints {
  /** e.g. ['chat', 'vision'] / ['image'] */
  capabilities?: string[];
  /** e.g. ['text', 'image'] */
  input_modalities?: string[];
  /** e.g. ['image'] / ['text'] */
  output_modalities?: string[];
}

/**
 * Resolves modality from structured capability data when available.
 * Returns 'unknown' if the payload carries nothing usable, so callers can fall
 * back to `inferModality(id)`.
 */
export function modalityFromCapabilities(caps: ModelCapabilityHints | undefined): ModelModality {
  if (!caps) return 'unknown';
  const outputs = caps.output_modalities || [];
  const inputs = caps.input_modalities || [];
  const abilities = (caps.capabilities || []).map(c => c.toLowerCase());

  const outputsImage = outputs.includes('image');
  const outputsText = outputs.includes('text');
  const acceptsImage = inputs.includes('image') || abilities.includes('vision');

  // Produces images AND understands them / talks → genuinely multi-purpose
  if (outputsImage && (acceptsImage || outputsText)) return 'multi';
  if (outputsImage) return 'image';
  // Understands images but answers in text → vision model (Describe's ideal pick)
  if (acceptsImage && outputsText) return 'multi';
  if (outputsText) return 'text';

  // No modality arrays: fall back to the coarse capability list
  if (abilities.includes('image')) return 'image';
  if (abilities.includes('vision')) return 'multi';
  if (abilities.includes('chat')) return 'text';
  return 'unknown';
}

/**
 * Best-effort modality: structured capabilities first, name patterns second.
 */
export function resolveModality(modelId: string, caps?: ModelCapabilityHints): ModelModality {
  const fromCaps = modalityFromCapabilities(caps);
  return fromCaps !== 'unknown' ? fromCaps : inferModality(modelId);
}

// ─── Task suitability (advisory only — never disables anything) ────────────────

/** Modalities that plausibly produce an image (Generate / Edit). */
export function canProduceImage(modality: ModelModality): boolean {
  return modality === 'image' || modality === 'multi' || modality === 'unknown';
}

/** Modalities that plausibly read an image and answer in text (Describe). */
export function canReadImage(modality: ModelModality): boolean {
  return modality === 'multi' || modality === 'unknown';
}

/** Soft warning for the current selection, or null when it looks fine.
 *  Shown as a hint next to the action button — the button stays clickable. */
export function modalityWarning(
  modality: ModelModality,
  task: 'image' | 'describe',
): string | null {
  if (task === 'image') {
    if (modality === 'text') return 'This looks like a text-only model — generation may fail.';
    return null;
  }
  if (modality === 'image') return 'This looks like an image-only model — it probably cannot describe.';
  if (modality === 'text') return 'This model may not accept images — Describe may fail.';
  return null;
}
