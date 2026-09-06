/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Unit tests for AI Bridge model modality classification.
 *
 * Two independent sources feed the classification:
 * - structured capability data, when a service exposes it (LocalAI-style)
 * - model name patterns, as the universal fallback
 *
 * The critical guarantee is that classification is ADVISORY: `unknown` is a
 * legal state and no modality is allowed to hard-block a task.
 */

import { describe, it, expect } from 'vitest';
import {
  inferModality,
  modalityFromCapabilities,
  resolveModality,
  canProduceImage,
  canReadImage,
  modalityWarning,
} from './modality';

describe('inferModality (name patterns)', () => {
  it('classifies text-to-image generators as image', () => {
    expect(inferModality('gpt-image-1')).toBe('image');
    expect(inferModality('dall-e-3')).toBe('image');
    expect(inferModality('flux.2-klein-4b')).toBe('image');
    expect(inferModality('stable-diffusion-xl')).toBe('image');
    expect(inferModality('sdxl-turbo')).toBe('image');
    expect(inferModality('imagen-3.0')).toBe('image');
    expect(inferModality('wanx-v1')).toBe('image');
  });

  it('classifies chat models as text', () => {
    expect(inferModality('gpt-4o')).toBe('text');
    expect(inferModality('o1-preview')).toBe('text');
    expect(inferModality('llama-3.1-70b')).toBe('text');
    expect(inferModality('mistral-large')).toBe('text');
    expect(inferModality('deepseek-chat')).toBe('text');
    expect(inferModality('qwen3.8-9b-q4')).toBe('text');
  });

  it('classifies vision models as multi, not text', () => {
    // Regression guard: the generic "qwen" text rule must not swallow qwen-vl
    expect(inferModality('qwen3-vl-4b-instruct')).toBe('multi');
    expect(inferModality('qwen-vl-max')).toBe('multi');
    expect(inferModality('llava-vision-7b')).toBe('multi');
    expect(inferModality('some-omni-model')).toBe('multi');
  });

  it('handles the naming of every built-in provider', () => {
    // Anthropic — chat/vision only, no generators
    expect(inferModality('claude-opus-5')).toBe('text');
    expect(inferModality('claude-sonnet-4')).toBe('text');

    // xAI — the Imagine generators must not be read as chat models
    expect(inferModality('grok-imagine-image-2.0')).toBe('image');
    expect(inferModality('grok-4.6')).toBe('multi');
    expect(inferModality('grok-2-vision')).toBe('multi');

    // Ollama — tag-suffixed local names (`model:tag`)
    expect(inferModality('gpt-oss:20b')).toBe('text');
    expect(inferModality('qwen3-vl:8b')).toBe('multi');
    expect(inferModality('llama3.2')).toBe('text');
    expect(inferModality('llava:13b')).toBe('multi');

    // LocalAI
    expect(inferModality('flux.2-klein-4b')).toBe('image');
    expect(inferModality('stablediffusion')).toBe('image');
  });

  it('returns unknown rather than guessing wildly', () => {
    expect(inferModality('my-finetune-v3')).toBe('unknown');
    expect(inferModality('')).toBe('unknown');
  });

describe('modalityFromCapabilities (structured data)', () => {
  // Payloads below mirror a real LocalAI /v1/models/capabilities response
  it('reads an image generator', () => {
    expect(modalityFromCapabilities({
      capabilities: ['image'],
      input_modalities: ['text'],
      output_modalities: ['image'],
    })).toBe('image');
  });

  it('reads a plain chat model', () => {
    expect(modalityFromCapabilities({
      capabilities: ['chat'],
      input_modalities: ['text'],
      output_modalities: ['text'],
    })).toBe('text');
  });

  it('reads a vision model as multi', () => {
    expect(modalityFromCapabilities({
      capabilities: ['chat', 'vision'],
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
    })).toBe('multi');
  });

  it('reads an any-to-any model as multi', () => {
    expect(modalityFromCapabilities({
      input_modalities: ['text', 'image'],
      output_modalities: ['text', 'image'],
    })).toBe('multi');
  });

  it('falls back to the coarse capability list when modalities are absent', () => {
    expect(modalityFromCapabilities({ capabilities: ['image'] })).toBe('image');
    expect(modalityFromCapabilities({ capabilities: ['vision'] })).toBe('multi');
    expect(modalityFromCapabilities({ capabilities: ['chat'] })).toBe('text');
  });

  it('returns unknown for an empty or missing payload', () => {
    expect(modalityFromCapabilities(undefined)).toBe('unknown');
    expect(modalityFromCapabilities({})).toBe('unknown');
  });
});

describe('resolveModality (structured data wins, names fall back)', () => {
  it('prefers structured capabilities over the name', () => {
    // Name says image, the server says chat — trust the server
    expect(resolveModality('flux-chat-adapter', {
      capabilities: ['chat'],
      output_modalities: ['text'],
    })).toBe('text');
  });

  it('falls back to the name when no capabilities are supplied', () => {
    expect(resolveModality('flux.2-klein-4b')).toBe('image');
  });

  it('falls back to the name when capabilities carry nothing usable', () => {
    expect(resolveModality('gpt-4o', {})).toBe('text');
  });
});

describe('task suitability is permissive (never a hard block)', () => {
  it('allows image tasks for anything except a confirmed text model', () => {
    expect(canProduceImage('image')).toBe(true);
    expect(canProduceImage('multi')).toBe(true);
    // unknown must be allowed through — the server is the authority
    expect(canProduceImage('unknown')).toBe(true);
    expect(canProduceImage('text')).toBe(false);
  });

  it('allows describe for vision and unknown models', () => {
    expect(canReadImage('multi')).toBe(true);
    expect(canReadImage('unknown')).toBe(true);
    expect(canReadImage('image')).toBe(false);
    expect(canReadImage('text')).toBe(false);
  });
});

describe('modalityWarning (advisory copy)', () => {
  it('warns when a text model is used for an image task', () => {
    expect(modalityWarning('text', 'image')).toMatch(/text-only/i);
  });

  it('stays silent for suitable image-task models', () => {
    expect(modalityWarning('image', 'image')).toBeNull();
    expect(modalityWarning('multi', 'image')).toBeNull();
    // unknown gets no warning — it is a legal state, not a problem
    expect(modalityWarning('unknown', 'image')).toBeNull();
  });

  it('warns when an image-only model is used for describe', () => {
    expect(modalityWarning('image', 'describe')).toMatch(/cannot describe/i);
  });

  it('stays silent for vision models on describe', () => {
    expect(modalityWarning('multi', 'describe')).toBeNull();
    expect(modalityWarning('unknown', 'describe')).toBeNull();
  });
});

});
