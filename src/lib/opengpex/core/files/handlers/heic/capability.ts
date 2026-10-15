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
 * HEVC hardware-decode capability probe — the ingest decision's one-time
 * environment signal.
 *
 * Two parallel `VideoDecoder.isConfigSupported` probes, cached as a module-level
 * Promise:
 *   - Main Still (`hvc1.3.70000000.L90.B0`) — every Apple camera file;
 *   - Main (`hvc1.1.6.L93.B0`) — the generic-8-bit fallback.
 *
 * Deliberately NO Main10 smoke probe: 10-bit never routes to WebCodecs
 * (probe-verified — Chrome yields opaque GPU frames, Safari silently degrades;
 * the 19b/19c proxy channel owns those files), so probing it would only add a
 * decode-cost lie to the capability table. `isConfigSupported`'s known Main10
 * false-positive is therefore irrelevant to this module.
 *
 * The decision context selects the entry by the FILE's hvcC profile_idc
 * (`metadata.raw.heicProfileIdc`: 3 = Main Still, anything else → Main).
 * Files layering rule: this module is the ONLY WebCodecs touchpoint feeding
 * the decision — the decision function itself stays a synchronous pure
 * function over `{metadata, env}`.
 *
 * @module core/files/handlers/heic/capability
 */

/** Canonical probe strings (probe-validated canned forms). */
const MAIN_STILL_CODEC = 'hvc1.3.70000000.L90.B0';
const MAIN_CODEC = 'hvc1.1.6.L93.B0';

export interface HevcCapability {
  /** Main Still profile (profile_idc 3) — the Apple camera path. */
  mainStill: boolean;
  /** Generic Main profile (profile_idc 1) fallback. */
  main: boolean;
}

let cached: Promise<HevcCapability> | null = null;

async function probe(): Promise<HevcCapability> {
  // No WebCodecs (old Safari, non-secure context, worker without interface):
  // declarative no-capability — HEIC 8-bit routes to the libheif proxy (19e).
  if (typeof VideoDecoder === 'undefined') {
    return { mainStill: false, main: false };
  }

  const supports = async (codec: string): Promise<boolean> => {
    try {
      const result = await VideoDecoder.isConfigSupported({
        codec,
        // A minimal description is NOT required by isConfigSupported for these
        // canned strings (probe-verified); omitting description probes the
        // decoder's pure string/table gate, which is the capability we mean.
        // description: undefined
      } as VideoDecoderConfig);
      return result.supported === true;
    } catch {
      return false;
    }
  };

  // Parallel — both probes are cheap table lookups on the GPU-process side.
  const [mainStill, main] = await Promise.all([supports(MAIN_STILL_CODEC), supports(MAIN_CODEC)]);
  return { mainStill, main };
}

/** One-shot capability probe, cached for the process lifetime. */
export function getHevcCapability(): Promise<HevcCapability> {
  if (!cached) cached = probe();
  return cached;
}

/**
 * The decision-context flag for one file: pick the probe entry matching the
 * file's hvcC profile_idc (3 = Main Still; anything else → Main fallback).
 * Unknown profile (metadata parsed without hvcC) conservatively requires the
 * Main entry.
 */
export async function isHevcHardDecodeAvailable(profileIdc: number | undefined): Promise<boolean> {
  const cap = await getHevcCapability();
  return profileIdc === 3 ? cap.mainStill : cap.main;
}
