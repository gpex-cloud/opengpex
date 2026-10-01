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
 * GpuTimer.ts — [PERF_MON] True per-pass GPU execution timing via `timestamp-query`.
 *
 * WHY THIS EXISTS (vs `onSubmittedWorkDone`): the latter resolves only when the
 * queue drains ALL prior work, so its number is end-to-end LATENCY inflated by
 * backlog — a saturated drag reports ~380ms for a present that actually costs
 * ~2ms. This timer writes GPU-side timestamps at pass begin/end and reads the
 * delta back, giving the REAL cost of a single composite / present pass
 * independent of queue depth — the one measurement that separates "the composite
 * genuinely takes X ms" from "X ms is just backlog".
 *
 * CONTRACT (one submit at a time):
 *   1. `startSubmit()` — returns false if a prior readback is still in flight
 *      (self-throttling: instrument only every few frames, never block).
 *   2. `pass(label)` — per render pass, spread the returned `timestampWrites`
 *      into the pass descriptor. Returns undefined when unsupported / not armed /
 *      capacity reached, so the caller just omits it.
 *   3. `resolve(encoder)` — record resolve+copy into the SAME encoder that owns
 *      the passes, BEFORE `encoder.finish()`.
 *   4. `read(cb)` — after `submit`, maps the readback buffer and hands `cb` the
 *      per-pass durations. Non-blocking; marks the timer busy until it resolves.
 *
 * All GPU timestamp values are nanoseconds (WebGPU normalises the unit), so a
 * delta / 1e6 is milliseconds. Zero cost / no allocation when the adapter lacks
 * `timestamp-query` — every method degrades to a no-op and `supported` is false.
 *
 * @module core/gpu/resources/GpuTimer
 */

import { GPUBufferUsage, GPUMapMode } from '@opengpex/editor/core/engine/gpu/constants';

export interface GpuTimerSample {
  readonly label: string;
  readonly ms: number;
}

export interface GpuTimerReport {
  /** last-end − first-begin across all instrumented passes of the submit. */
  readonly spanMs: number;
  /** Per-pass (end − begin) durations, in encode order. */
  readonly passes: GpuTimerSample[];
}

const BYTES_PER_TIMESTAMP = 8; // u64 nanoseconds

export class GpuTimer {
  private readonly querySet: GPUQuerySet | null;
  private readonly resolveBuf: GPUBuffer | null;
  private readonly readBuf: GPUBuffer | null;
  private readonly capacity: number;

  private cursor = 0;
  private labels: string[] = [];
  private beginIdx: number[] = [];
  private endIdx: number[] = [];
  private armed = false;
  private busy = false;

  /**
   * @param capacity number of timestamp SLOTS (2 per pass), so `capacity/2`
   * passes can be instrumented per submit. 32 → 16 passes, ample for a composite.
   */
  constructor(device: GPUDevice, label: string, capacity = 32) {
    this.capacity = capacity;
    if (device.features?.has('timestamp-query')) {
      this.querySet = device.createQuerySet({ type: 'timestamp', count: capacity });
      this.resolveBuf = device.createBuffer({
        label: `${label} resolve`,
        size: capacity * BYTES_PER_TIMESTAMP,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
      this.readBuf = device.createBuffer({
        label: `${label} readback`,
        size: capacity * BYTES_PER_TIMESTAMP,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    } else {
      this.querySet = null;
      this.resolveBuf = null;
      this.readBuf = null;
    }
  }

  get supported(): boolean {
    return this.querySet !== null;
  }

  /**
   * Begin instrumenting a new submit. Returns false (skip this frame) when
   * unsupported or a previous readback has not completed — never blocks.
   */
  startSubmit(): boolean {
    if (!this.supported || this.busy) return false;
    this.cursor = 0;
    this.labels = [];
    this.beginIdx = [];
    this.endIdx = [];
    this.armed = true;
    return true;
  }

  /**
   * Allocate a begin/end timestamp pair for one render (or compute) pass. Spread
   * the result into the pass descriptor's `timestampWrites`. Undefined when the
   * timer is not armed or out of slots — the caller then omits `timestampWrites`.
   */
  pass(label: string): GPURenderPassTimestampWrites | undefined {
    if (!this.armed || !this.querySet) return undefined;
    if (this.cursor + 2 > this.capacity) return undefined;
    const b = this.cursor++;
    const e = this.cursor++;
    this.labels.push(label);
    this.beginIdx.push(b);
    this.endIdx.push(e);
    return { querySet: this.querySet, beginningOfPassWriteIndex: b, endOfPassWriteIndex: e };
  }

  /**
   * Record the resolve + copy-to-readback into `encoder` right before its
   * `finish()`. No-op when nothing was instrumented this submit.
   */
  resolve(encoder: GPUCommandEncoder): void {
    if (!this.armed || this.cursor === 0 || !this.querySet || !this.resolveBuf || !this.readBuf) {
      return;
    }
    encoder.resolveQuerySet(this.querySet, 0, this.cursor, this.resolveBuf, 0);
    encoder.copyBufferToBuffer(
      this.resolveBuf,
      0,
      this.readBuf,
      0,
      this.cursor * BYTES_PER_TIMESTAMP,
    );
  }

  /**
   * After the submit, map the readback buffer and hand `cb` the per-pass
   * durations. Non-blocking; the timer stays busy (skips new submits) until the
   * map resolves. No-op / never fires `cb` when nothing was instrumented.
   */
  read(cb: (report: GpuTimerReport) => void): void {
    if (!this.armed || this.cursor === 0 || !this.readBuf) {
      this.armed = false;
      return;
    }
    const count = this.cursor;
    const labels = this.labels.slice();
    const bI = this.beginIdx.slice();
    const eI = this.endIdx.slice();
    this.armed = false;
    this.busy = true;

    const buf = this.readBuf;
    buf
      .mapAsync(GPUMapMode.READ, 0, count * BYTES_PER_TIMESTAMP)
      .then(() => {
        // Copy out BEFORE unmap; the mapped range is invalid afterwards.
        const ts = new BigInt64Array(buf.getMappedRange(0, count * BYTES_PER_TIMESTAMP).slice(0));
        buf.unmap();

        const passes: GpuTimerSample[] = labels.map((label, i) => ({
          label,
          ms: Number(ts[eI[i]] - ts[bI[i]]) / 1e6,
        }));
        let minBegin = ts[bI[0]];
        let maxEnd = ts[eI[0]];
        for (let i = 1; i < labels.length; i++) {
          if (ts[bI[i]] < minBegin) minBegin = ts[bI[i]];
          if (ts[eI[i]] > maxEnd) maxEnd = ts[eI[i]];
        }
        cb({ spanMs: Number(maxEnd - minBegin) / 1e6, passes });
      })
      .catch(() => {
        /* device lost / buffer destroyed — drop this sample */
      })
      .finally(() => {
        this.busy = false;
      });
  }

  destroy(): void {
    this.querySet?.destroy();
    this.resolveBuf?.destroy();
    this.readBuf?.destroy();
  }
}
