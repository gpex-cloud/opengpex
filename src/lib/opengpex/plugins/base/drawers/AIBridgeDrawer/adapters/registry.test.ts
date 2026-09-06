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
 * Unit tests for the provider registry.
 *
 * These lock in the structural invariants that keep provider selection
 * predictable — every entry must be complete, keys must be unique, and the
 * declared capabilities must match reality (Anthropic and Ollama genuinely have
 * no image generation API, so they must say so rather than fail at request time).
 */

import { describe, it, expect } from 'vitest';
import { PROVIDER_REGISTRY, getProvider, getAdapter, DEFAULT_PROVIDER_KEY } from './registry';
import type { AIEndpoint } from './types';

const endpointFor = (provider: string): AIEndpoint => ({
  id: 'e1', name: 'Test', baseUrl: 'https://example.com', apiKey: 'k', provider,
});

describe('registry integrity', () => {
  it('has unique provider keys', () => {
    const keys = PROVIDER_REGISTRY.map(p => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every provider the full metadata a dropdown needs', () => {
    for (const p of PROVIDER_REGISTRY) {
      expect(p.key, 'key').toBeTruthy();
      expect(p.displayName, `${p.key} displayName`).toBeTruthy();
      expect(p.description, `${p.key} description`).toBeTruthy();
      // defaultBaseUrl may legitimately be '' (LocalAI: user supplies their own)
      expect(typeof p.defaultBaseUrl, `${p.key} defaultBaseUrl`).toBe('string');
    }
  });

  it('implements every task method on every provider', () => {
    for (const p of PROVIDER_REGISTRY) {
      for (const fn of ['generate', 'edit', 'describe', 'chat', 'fetchModels'] as const) {
        expect(typeof p[fn], `${p.key}.${fn}`).toBe('function');
      }
    }
  });

  it('declares all four capability flags on every provider', () => {
    for (const p of PROVIDER_REGISTRY) {
      for (const cap of ['generate', 'edit', 'describe', 'chat'] as const) {
        expect(typeof p.capabilities[cap], `${p.key}.capabilities.${cap}`).toBe('boolean');
      }
    }
  });

  it('lets every provider do at least one task', () => {
    for (const p of PROVIDER_REGISTRY) {
      const any = Object.values(p.capabilities).some(Boolean);
      expect(any, `${p.key} must support something`).toBe(true);
    }
  });
});

describe('declared capabilities match each service', () => {
  it('covers the major hosted providers plus two self-hosted options', () => {
    const keys = PROVIDER_REGISTRY.map(p => p.key);
    expect(keys).toContain('openai');
    expect(keys).toContain('anthropic');
    expect(keys).toContain('gemini');
    expect(keys).toContain('xai');
    expect(keys).toContain('qwen');
    // Two distinct self-hosted routes: LocalAI generates, Ollama does not
    expect(keys).toContain('localai');
    expect(keys).toContain('ollama');
  });

  it('marks image-capable providers as such', () => {
    for (const key of ['openai', 'gemini', 'xai', 'qwen', 'localai']) {
      const p = getProvider(key)!;
      expect(p.capabilities.generate, `${key} generate`).toBe(true);
      expect(p.capabilities.edit, `${key} edit`).toBe(true);
    }
  });

  it('marks Anthropic as vision/chat only — Claude has no image generation API', () => {
    const p = getProvider('anthropic')!;
    expect(p.capabilities.generate).toBe(false);
    expect(p.capabilities.edit).toBe(false);
    expect(p.capabilities.describe).toBe(true);
    expect(p.capabilities.chat).toBe(true);
  });

  it('marks Ollama as vision/chat only — it serves language, not diffusion, models', () => {
    const p = getProvider('ollama')!;
    expect(p.capabilities.generate).toBe(false);
    expect(p.capabilities.edit).toBe(false);
    expect(p.capabilities.describe).toBe(true);
    expect(p.capabilities.chat).toBe(true);
  });

  it('rejects unsupported tasks with an actionable message', async () => {
    const p = getProvider('anthropic')!;
    await expect(p.generate(endpointFor('anthropic'), { prompt: 'x', size: '1024x1024' }))
      .rejects.toThrow(/does not offer image generation/i);
    await expect(p.edit(endpointFor('anthropic'), { images: [], prompt: 'x', size: '1024x1024' }))
      .rejects.toThrow(/does not offer image editing/i);
  });

  it('lets every provider read images, so Describe always has a home', () => {
    for (const p of PROVIDER_REGISTRY) {
      expect(p.capabilities.describe, `${p.key} describe`).toBe(true);
    }
  });
});

describe('provider lookup', () => {
  it('finds a provider by key', () => {
    expect(getProvider('gemini')?.key).toBe('gemini');
  });

  it('returns undefined for unknown or missing keys', () => {
    expect(getProvider('nope')).toBeUndefined();
    expect(getProvider(undefined)).toBeUndefined();
  });

  it('falls back to the default provider so a stale config stays usable', () => {
    // A config referencing a removed provider must still yield a working adapter
    expect(getAdapter(endpointFor('removed-provider')).key).toBe(DEFAULT_PROVIDER_KEY);
    expect(getAdapter(undefined).key).toBe(DEFAULT_PROVIDER_KEY);
  });
});
