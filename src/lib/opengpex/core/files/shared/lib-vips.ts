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
 * LibVips — files-layer shared wasm-vips Worker proxy.
 *
 * ARCHITECTURE (20260912_tiff_png_shared_libvips_worker_proposal):
 * vips is fundamentally a FILE-TRANSCODING library, so it belongs to
 * `core/files` (the format layer), NOT `core/engine` (the render layer). This
 * proxy owns a files-layer vips Worker directly — exactly like RAW owns its
 * libraw Worker (`handlers/raw/libraw.ts`) — instead of reaching back into
 * `PixelService.fileIO` (engine).
 *
 * WHY A PROCESS-WIDE SINGLETON (vs. RAW's per-handler `new LibRaw()`): vips is
 * an Emscripten pthread build behind COOP/COEP with a large fixed heap; each
 * `new` would spawn another pthread pool + heap (memory doubles). TIFF and PNG
 * therefore SHARE one instance via {@link getLibVips}. This preserves the RAW
 * architecture shape (handler → self-owned transcode worker) while differing
 * only in sharing granularity — a difference dictated by vips vs. libraw.
 *
 * `decode()` produces the 8-bit display pixels AND, when `wantHighDepth`, the
 * naked high-bit-depth pixels in ONE call (mirroring `convertRawToBlob`'s dual
 * output). The precision container is decided HERE in TS, per source band format:
 * an integer source is packed to f16 (reusing
 * `color/float16` / `color/wideGamutF16`, the single source of truth shared with
 * engine `decodeHighDepth`), while a genuine FLOAT source passes through
 * verbatim as `rgba32float`. Either way the Worker stays a pure vips script that
 * only ships naked ushort/float buffers.
 *
 * Protocol: { id, fn, args } → { id, out } | { id, error } (isomorphic with the
 * other files-layer workers / libraw-worker.js).
 */

import type { GamutId } from '@opengpex/editor/core/types';
import {
  normalizedUint16ToFloat16,
  wideGamut8ToF16,
  wideGamut16ToF16,
} from '@opengpex/editor/core/engine/color';
import { renderDisplayProxy } from './lib-custom';

// ═══════════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════════

/** Options for {@link LibVips.decode}. */
export interface LibVipsDecodeOptions {
  /**
   * Skip vips' ICC/colourspace transform so original pixel encoding is retained
   * (matches engine `decodeTiff(bytes, { preserveColorSpace: true })`). The
   * matrix / none color branches decode preserved pixels then convert on the
   * CPU; the icc-engine branch calls {@link LibVips.iccToSrgb} instead (full
   * Little CMS transform), not this preserve-mode decode.
   */
  preserveColorSpace?: boolean;
  /**
   * Also decode the full-precision (16/32-bit) naked pixels for a direct
   * high-depth upload: an integer source is packed to IEEE binary16
   * (`rgba16float`), a float source passes through as true f32 (`rgba32float`).
   * Read the container off {@link LibVipsHighDepth.format} — never assume. Set
   * only when the source's `metadata.bitDepth > 8` (the 8/16 decision lives in
   * the handler, per RAW).
   */
  wantHighDepth?: boolean;
  /**
   * When the source is a wide gamut (adobe-rgb / prophoto-rgb), degamma the naked
   * high-depth ushort onto the raw f16-LINEAR line via {@link wideGamut16ToF16},
   * instead of the color-management-agnostic `/65535` normalize (which keeps the
   * source gamma). Set by the `vips` decode channel so the packed f16 matches the
   * authoritative `colorIdentity.trc:'linear'`. Ignored for srgb/p3 sources (kept gamma-encoded + `srgb-trc`)
   * and for float sources (already linear).
   *
   * Note: When `gamut` is provided, this option is inferred automatically.
   */
  wideGamutDegamma?: 'adobe-rgb' | 'prophoto-rgb';
  /**
   * Source gamut ID (srgb / display-p3 / adobe-rgb / prophoto-rgb). When provided:
   * 1. `displayBlob` is automatically rendered via {@link renderDisplayProxy};
   * 2. Wide-gamut (adobe-rgb / prophoto-rgb) sources automatically degamma high-depth:
   *    - >8-bit: uses {@link wideGamut16ToF16};
   *    - 8-bit: automatically lifts naked 8-bit pixels via {@link wideGamut8ToF16} into f16 linear.
   */
  gamut?: GamutId;
  /**
   * Zero-based page to decode within a multi-page container (multi-page TIFF).
   * Defaults to 0, so every existing single-page caller is byte-identical. Both
   * the 8-bit display read AND the high-depth read honour it, which is what makes
   * per-page high-depth possible at all: this is the ONLY vips entry that emits
   * both products from one pass, and it used to hard-code page 0.
   */
  page?: number;
}

/** Pre-packed high-bit-depth naked pixels (f16 bit patterns, or true f32). */
export interface LibVipsHighDepth {
  /**
   * Naked RGBA-interleaved high-depth pixels, in the container `format` names:
   *   • `rgba16float` → `Uint16Array` of IEEE binary16 bit patterns (see color/float16);
   *   • `rgba32float` → `Float32Array` of true 32-bit floats, passed through
   *     VERBATIM from vips.
   */
  data: Uint16Array | Float32Array;
  width: number;
  height: number;
  /**
   * The precision container these bytes actually are — DERIVED from the vips
   * band format (`isFloat`), never assumed. A float source stays `rgba32float`
   * (16 bytes/texel); everything else packs to `rgba16float` (8 bytes/texel).
   * ⚠️ Consumers MUST read this rather than hard-coding a literal: it is what
   * the GPU upload derives `bytesPerRow` from, so a wrong value mis-strides the
   * whole image.
   */
  format: 'rgba16float' | 'rgba32float';
  /** Transfer characteristic from vips `interpretation` (never `frame.trc`). */
  trc: 'srgb-trc' | 'linear';
  /** The source's TRUE precision (8/16/32) — lets the caller reject 8-bit-with-raw. */
  sourceBitDepth: number;
}

/** Result of {@link LibVips.decode}. */
export interface LibVipsDecodeResult {
  /** 8-bit RGBA naked pixels (bit-exact with engine `decodeTiff`). */
  data: Uint8Array;
  width: number;
  height: number;
  /** Present when `wantHighDepth` AND source >8-bit, OR when 8-bit wide-gamut is lifted. */
  highDepth?: LibVipsHighDepth;
  /** Rendered display proxy Blob, generated when `gamut` is provided. */
  displayBlob?: Blob;
}

/** Raw Worker `decode` output (naked pixels; f16 packing happens in TS). */
interface WorkerDecodeOut {
  width: number;
  height: number;
  data: Uint8Array;
  highDepth?: {
    width: number;
    height: number;
    /** ushort (Uint16Array) or float (Float32Array) naked RGBA, per `isFloat`. */
    naked: Uint16Array | Float32Array;
    isFloat: boolean;
    sourceBitDepth: number;
    sourceTrc: 'srgb-trc' | 'linear';
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// Crash recovery + worker variants
// ═══════════════════════════════════════════════════════════════════════════════

/** Default (upstream npm) wasm-vips worker: fixed 1 GiB heap. */
const VIPS_WORKER_URL = '/hb/wasm/vips-2g/vips-worker.js?base=%2Fhb%2Fwasm%2Fvips-2g%2F';
/**
 * Self-built wasm-vips variant with MAXIMUM_MEMORY=2GB + ALLOW_MEMORY_GROWTH
 * (see gpex-assets/wasm/). Served as a static copy under /hb/wasm/vips-2g/; the
 * `base` query param tells vips-worker.js where to find the sibling vips.js /
 * vips.wasm of THAT variant. The directory is committed to the repository.
 */
/**
 * Pixel-count threshold above which callers are routed to the 2 GB variant.
 * The fixed 1 GiB heap puts the practical ceiling at roughly 12-20 MP for
 * 16-bit/float payloads and ~40 MP for 8-bit (see plan §12.10), so >16 MP is
 * where the shared 1 GiB singleton starts aborting non-deterministically.
 */

/**
 * A failure that justifies rebuilding the shared worker. Emscripten heap
 * exhaustion surfaces as an `unreachable`/`unwind` abort (uncaught, kills the
 * worker script) or a native `memory access out of bounds`; libvips also
 * abort()s on internal invariant breaks. A plain `vips::Error` (bad/unsupported
 * file) is a NORMAL, contained failure — the worker survives it — and must not
 * trigger a rebuild.
 */
function isRecoverableVipsFailure(err: unknown): boolean {
  if (err instanceof VipsWorkerCrashError || err instanceof VipsCallTimeoutError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\bunreachable\b|\bunwind\b|abort\(|out of memory|memory access out of bounds/i.test(msg);
}

/** Worker-level failure (uncaught exception / script load error) — the worker is dead. */
class VipsWorkerCrashError extends Error {
  constructor(message: string) {
    super(`vips worker crashed: ${message}`);
    this.name = 'VipsWorkerCrashError';
  }
}

/** In-flight call aborted because the worker was rebuilt underneath it (a sibling call's recovery). */
class VipsWorkerRebuiltError extends Error {
  constructor() {
    super('vips worker was rebuilt while the call was in flight');
    this.name = 'VipsWorkerRebuiltError';
  }
}

/** A single call exceeded the watchdog — the worker is presumed poisoned. */
class VipsCallTimeoutError extends Error {
  constructor(ms: number) {
    super(`vips call timed out after ${ms} ms`);
    this.name = 'VipsCallTimeoutError';
  }
}

/**
 * Watchdog per in-flight call. wasm-vips aborts leave the shared singleton
 * poisoned (every later call fails with vips::Error until the page is
 * reloaded — observed twice on 48 MP HEIC→TIFF16 back-to-back exports), and a
 * hard abort kills the worker script outright, so neither a response nor a
 * worker `error` event may ever arrive. Every call therefore gets a timeout
 * after which it is failed as recoverable and the worker is rebuilt.
 */
const VIPS_CALL_TIMEOUT_MS = 120_000;

/** Maximum automatic rebuilds per instance lifetime (runaway-loop guard). */
const MAX_WORKER_REBUILDS = 3;

// ═══════════════════════════════════════════════════════════════════════════════
// LibVips Worker Class
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Thin wrapper around the classic (importScripts-based) vips-worker.js Worker.
 * Serializes calls in order and handles the Worker lifecycle. Not exported —
 * callers obtain a shared instance via {@link getLibVips}.
 *
 * CRASH RECOVERY: the underlying wasm-vips heap is finite (1 GiB upstream, 2 GB
 * in the self-built variant) and the Emscripten module aborts — rather than
 * throwing — when it is exhausted. An abort poisons the shared singleton and
 * usually kills the worker script. On a recoverable failure (see
 * {@link isRecoverableVipsFailure}) the whole worker is torn down and rebuilt,
 * and the failed call retried ONCE on the fresh instance; retries are safe
 * precisely because the bridge never transfers the caller's buffers (they
 * survive structured clone and stay attached on this side). Plain vips::Error
 * responses are passed through untouched.
 */
class LibVips {
  private worker: Worker;
  private pending: Map<number, {
    resolve: (val: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
  private nextId: number = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed: boolean = false;
  /** Rebuilds consumed so far (lifetime cap {@link MAX_WORKER_REBUILDS}). */
  private rebuildsUsed: number = 0;
  /** Whether ANY call on this instance ever succeeded — distinguishes "variant never loaded" from "worn out". */
  private everSucceeded: boolean = false;
  private scriptUrl: string = VIPS_WORKER_URL;

  constructor() {
    this.pending = new Map();
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    // Classic Worker (NOT { type: 'module' }): vips-worker.js uses importScripts,
    // which is only available in classic workers.
    const worker = new Worker(this.scriptUrl);
    worker.onmessage = ({ data: e }) => {
      const t = this.pending.get(e?.id);
      if (t) {
        clearTimeout(t.timer);
        this.pending.delete(e.id);
        if (e?.error) {
          t.reject(new Error(e.error));
        } else {
          this.everSucceeded = true;
          t.resolve(e?.out);
        }
      }
    };
    worker.onerror = (ev) => {
      const detail = (ev as { message?: string })?.message || 'unknown error';
      // Fail every in-flight call as RECOVERABLE: the script is dead (hard abort
      // or failed variant load), so a rebuild is the only way forward.
      for (const t of this.pending.values()) {
        clearTimeout(t.timer);
        t.reject(new VipsWorkerCrashError(detail));
      }
      this.pending.clear();
    };
    return worker;
  }

  /**
   * Tear down the current worker and start a fresh one. If this instance was
   * created for an optional variant (the self-built 2 GB build) and that
   * variant never managed a single successful call, the rebuild silently
   * switches to the default worker instead — the variant directory is simply
   * not provisioned, and retrying it forever would fail every large call.
   */
  private rebuild(): void {
    this.rebuildsUsed++;
    this.worker.terminate();
    // Calls already posted to the dead worker would otherwise hang until their
    // own timeout: fail them now so each retries on the fresh worker. They are
    // NOT counted as crashes — the recovery already happened once, here.
    for (const t of this.pending.values()) {
      clearTimeout(t.timer);
      t.reject(new VipsWorkerRebuiltError());
    }
    this.pending.clear();
    this.worker = this.spawn();
  }

  /**
   * One serialized call with automatic crash recovery: a recoverable failure
   * (heap abort / worker crash / watchdog timeout) rebuilds the worker and
   * retries the call exactly once. Retrying is safe because the caller's
   * buffers are never transferred — they are still attached on this side.
   */
  private async call(fn: string, ...args: unknown[]): Promise<unknown> {
    try {
      return await this.runFn(fn, ...args);
    } catch (err) {
      if (this.disposed) throw err;
      if (err instanceof VipsWorkerRebuiltError) {
        // A sibling call's recovery already replaced the worker: just re-post,
        // without burning another rebuild from this call's budget.
        return await this.runFn(fn, ...args);
      }
      if (!isRecoverableVipsFailure(err) || this.rebuildsUsed >= MAX_WORKER_REBUILDS) {
        throw err;
      }
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[LibVips] recoverable failure in ${fn} (${detail}); rebuilding vips worker (rebuild ${this.rebuildsUsed + 1}/${MAX_WORKER_REBUILDS}) and retrying once`);
      this.rebuild();
      return await this.runFn(fn, ...args);
    }
  }

  dispose() {
    this.disposed = true;
    this.worker.terminate();
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('LibVips disposed'));
    }
    this.pending.clear();
  }

  private runFn(fn: string, ...args: unknown[]): Promise<unknown> {
    const n = () => new Promise<unknown>((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('LibVips disposed'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        const t = this.pending.get(id);
        if (t) {
          this.pending.delete(id);
          t.reject(new VipsCallTimeoutError(VIPS_CALL_TIMEOUT_MS));
        }
      }, VIPS_CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });

      // NO transfer list on purpose: transferring detaches the caller's
      // ArrayBuffer, and several call sites legitimately reuse the same bytes
      // across worker calls (TIFF vips-icc runs iccToSrgb then a high-depth
      // decode on the same buffer; multi-page TIFF decodes the same buffer per
      // page). postMessage's structured clone already copies the payload, so
      // the only thing the transfer list ever bought was a copy we can afford —
      // at the cost of opaque DataCloneErrors on the second call.

      this.worker.postMessage({ id, fn, args });
    });

    const a = this.tail.then(n, n);
    this.tail = a.then(() => {}, () => {});
    return a;
  }

  /**
   * Decode a container (TIFF/PNG bytes) to 8-bit RGBA and, when requested,
   * pre-packed high-bit-depth f16 naked pixels — in a single vips pass.
   */
  async decode(bytes: Uint8Array, opts?: LibVipsDecodeOptions): Promise<LibVipsDecodeResult> {
    const out = (await this.call('decode', bytes, opts || {})) as WorkerDecodeOut;

    const wideGamutTarget: 'adobe-rgb' | 'prophoto-rgb' | undefined =
      opts?.wideGamutDegamma ??
      (opts?.gamut === 'adobe-rgb' || opts?.gamut === 'prophoto-rgb' ? opts.gamut : undefined);

    let highDepth: LibVipsHighDepth | undefined;
    if (out.highDepth) {
      const hd = out.highDepth;
      // Pack naked → the precision container the source actually warrants:
      //   • float  → PASSTHROUGH. vips already handed us true f32 (double was
      //     cast('float') in the worker), so there is nothing to do: the buffer
      //     IS the truth and goes straight out as `rgba32float`. This
      //     used to call `linearFloatToFloat16` unconditionally, which crushed a
      //     10-bit-mantissa / 65504-max lid onto HDR-linear sources at the ONLY
      //     decode they ever get — the loss was unrecoverable afterwards.
      //   • ushort → normalize (/65535) → f16. NEVER swap these two: mixing them
      //     either blows or crushes the range (see color/float16 doc comments).
      //
      // Wide-gamut ushort is the exception: when `wideGamutTarget` names the source
      // gamut, `wideGamut16ToF16` linearizes with the correct source gamma so the
      // packed f16 is genuinely LINEAR (matches colorIdentity.trc:'linear')
      // rather than the source-gamma-encoded pixels the plain normalize would keep.
      let data: Uint16Array | Float32Array;
      let trc: 'srgb-trc' | 'linear';
      if (hd.isFloat) {
        data = hd.naked as Float32Array;
        trc = hd.sourceTrc;
      } else if (wideGamutTarget) {
        data = wideGamut16ToF16(hd.naked as Uint16Array, hd.width, hd.height, wideGamutTarget).data;
        trc = 'linear';
      } else {
        data = normalizedUint16ToFloat16(hd.naked as Uint16Array);
        trc = hd.sourceTrc;
      }
      highDepth = {
        data,
        width: hd.width,
        height: hd.height,
        // Derived from the vips band format, not assumed: float passes through as
        // 16 bytes/texel, the two ushort branches above packed to 8.
        format: hd.isFloat ? 'rgba32float' : 'rgba16float',
        trc,
        sourceBitDepth: hd.sourceBitDepth,
      };
    } else if (wideGamutTarget) {
      // 8-bit wide-gamut source (e.g. 8-bit Adobe RGB / ProPhoto TIFF):
      // worker emitted no highDepth because sourceBitDepth <= 8, but wide gamut requires
      // the unclamped f16 linear lift so downstream GPU pipeline preserves super-P3 colors.
      const clamped = new Uint8ClampedArray(out.width * out.height * 4);
      clamped.set(out.data);
      const hd = wideGamut8ToF16(clamped, out.width, out.height, wideGamutTarget);
      highDepth = {
        data: hd.data,
        width: hd.width,
        height: hd.height,
        format: 'rgba16float',
        trc: 'linear',
        sourceBitDepth: 8,
      };
    }

    let displayBlob: Blob | undefined;
    if (opts?.gamut) {
      displayBlob = await renderDisplayProxy(out.data, out.width, out.height, opts.gamut);
    }

    return { data: out.data, width: out.width, height: out.height, highDepth, displayBlob };
  }

  /**
   * Get page count + first-page dimensions of a (possibly multi-page) TIFF.
   * Forwards to the worker's `tiffPageCount` (probe-based, robust across vips
   * versions). Migrated off engine `pixels.fileIO.getPageCount` — a pure TIFF
   * container op that belongs to the files layer.
   */
  async getPageCount(bytes: Uint8Array): Promise<{ pages: number; pageWidth: number; pageHeight: number }> {
    return (await this.call('tiffPageCount', bytes)) as { pages: number; pageWidth: number; pageHeight: number };
  }

  /**
   * Decode a specific page of a multi-page TIFF → 8-bit RGBA naked pixels.
   * Forwards to the worker's `tiffDecodePage`. Migrated off engine
   * `pixels.fileIO.decodePage`.
   */
  async decodePage(bytes: Uint8Array, page: number): Promise<{ width: number; height: number; data: Uint8Array }> {
    return (await this.call('tiffDecodePage', bytes, page)) as { width: number; height: number; data: Uint8Array };
  }

  /**
   * Encode 8-bit RGBA pixels → TIFF container bytes via vips (NO metadata
   * injection — EXIF/IFD0 tagging is a pure byte op done by the TIFF handler
   * itself in `tiff/encode.ts`, keeping that concern inside the files layer
   * rather than round-tripping through engine, as it did pre-migration).
   */
  async encodeTiff(
    rgbaData: Uint8Array,
    width: number,
    height: number,
    options: Record<string, unknown>,
  ): Promise<Uint8Array> {
    return (await this.call('encodeTiff', rgbaData, width, height, options)) as Uint8Array;
  }

  /**
   * Encode RGBA pixels (8-bit or 16-bit) → PNG container bytes via vips.
   */
  async encodePng(
    rgbaData: Uint8Array,
    width: number,
    height: number,
    options: Record<string, unknown>,
  ): Promise<Uint8Array> {
    return (await this.call('encodePng', rgbaData, width, height, options)) as Uint8Array;
  }

  /**
   * Encode 8-bit RGBA pixels → JPEG container bytes via vips (libjpeg-turbo),
   * at a FIXED 4:4:4 chroma subsampling (`subsample_mode: 'off'`). This replaced
   * the browser canvas `convertToBlob` encoder, which offers no subsampling
   * control and always writes 4:2:0 (measured Q92 PSNR 34 dB vs 47 dB on
   * saturated content).
   */
  async encodeJpeg(
    rgbaData: Uint8Array,
    width: number,
    height: number,
    options: Record<string, unknown>,
  ): Promise<Uint8Array> {
    return (await this.call('encodeJpeg', rgbaData, width, height, options)) as Uint8Array;
  }

  /**
   * Convert image bytes with a non-sRGB ICC profile → sRGB RGBA (8-bit) via vips
   * (Little CMS). Handles Adobe RGB, ProPhoto, Display P3, CMYK and custom
   * profiles. Also returns the raw embedded ICC profile bytes for round-trip
   * export. Migrated off the engine `IccHandler` (`pixels.fileIO.iccToSrgb`) so
   * the engine worker no longer needs its own wasm-vips instance (20260912).
   */
  async iccToSrgb(
    bytes: Uint8Array,
  ): Promise<{ width: number; height: number; data: Uint8Array; iccProfileData?: Uint8Array }> {
    return (await this.call('iccToSrgb', bytes)) as {
      width: number;
      height: number;
      data: Uint8Array;
      iccProfileData?: Uint8Array;
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shared singleton accessor(s)
// ═══════════════════════════════════════════════════════════════════════════════

/** The process-wide shared instance (the 2 GB self-built build). */
let sharedInstance: LibVips | null = null;

/**
 * Returns a process-wide shared LibVips instance (lazily created). Handlers
 * MUST go through this — never `new LibVips()` — so vips consumers share
 * workers (one pthread pool + one heap each). See the file header for rationale.
 *
 * Every consumer shares ONE instance (the 2 GB self-built build); handlers
 * MUST go through this — never `new LibVips()` — so vips consumers share
 * workers (one pthread pool + one heap).
 */
export function getLibVips(): LibVips {
  if (!sharedInstance) sharedInstance = new LibVips();
  return sharedInstance;
}
export type { LibVips };
