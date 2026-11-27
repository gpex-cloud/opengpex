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
 * RenderPerfMonitor.ts — Rolling-window CPU/GPU telemetry for `WebGpuEngine`.
 *
 * Zero-cost when `PERF_MON` is disabled: all instrumentation hooks short-circuit.
 *
 * @module core/engine/pipeline/runtime/RenderPerfMonitor
 */

import { GpuTimer } from '@opengpex/editor/core/engine/gpu/resources/GpuTimer';
import { formatWorkingSetMiB, type WorkingSet } from '@opengpex/editor/core/engine/gpu/resources/WorkingSet';
import { PERF_MON } from '@opengpex/editor/core/helpers/config';

/**
 * Fire `cb` once the GPU has finished all work submitted up to now.
 * `GPUQueue.onSubmittedWorkDone` exists at runtime but is absent from the pinned
 * `@webgpu/types`, so it is reached through a narrow cast and skipped if missing.
 */
function onQueueDone(queue: GPUQueue, cb: () => void): void {
  const done = (queue as unknown as { onSubmittedWorkDone?: () => Promise<void> })
    .onSubmittedWorkDone;
  if (typeof done !== 'function') return;
  done.call(queue).then(cb).catch(() => { /* device lost — ignore */ });
}

export interface FramePerfSample {
  compileMs: number;
  sigMs: number;
  sigMiss: boolean;
  recomposite: boolean;
  recompositeRoi: boolean;
  compEncMs: number;
  presEncMs: number;
  docW: number;
  docH: number;
  layers: number;
  mode: 'full' | 'roi';
  roiTargetW: number;
  roiTargetH: number;
  roiDensity: number;
  workingSet: WorkingSet;
}

export class RenderPerfMonitor {
  private compTimer: GpuTimer | null = null;
  private presTimer: GpuTimer | null = null;

  private readonly window = {
    n: 0,
    compileSum: 0, compileMax: 0,
    sigSum: 0, sigMax: 0, sigMiss: 0,
    recompN: 0, roiRecompN: 0, compEncSum: 0, compEncMax: 0,
    presEncSum: 0, presEncMax: 0,
    compGpuSum: 0, compGpuN: 0, compGpuMax: 0,
    presGpuSum: 0, presGpuN: 0, presGpuMax: 0,
    tsCompSpanSum: 0, tsCompSpanN: 0, tsCompSpanMax: 0,
    tsPass: {} as Record<string, { sum: number; n: number; max: number }>,
    docW: 0, docH: 0, layers: 0,
    mode: 'full' as 'full' | 'roi',
    roiTargetW: 0, roiTargetH: 0, roiDensity: 0,
    lastFlush: 0,
  };

  armComposite(device: GPUDevice, armTimer: boolean): GpuTimer | undefined {
    if (!PERF_MON || !armTimer) return undefined;
    if (!this.compTimer) this.compTimer = new GpuTimer(device, 'composite');
    return this.compTimer.startSubmit() ? this.compTimer : undefined;
  }

  recordComposite(device: GPUDevice, perfStart: number, armedTimer: GpuTimer | undefined): number {
    if (!PERF_MON) return 0;
    const encMs = performance.now() - perfStart;
    onQueueDone(device.queue, () => {
      const ms = performance.now() - perfStart;
      const w = this.window;
      w.compGpuSum += ms;
      w.compGpuN++;
      if (ms > w.compGpuMax) w.compGpuMax = ms;
    });
    if (armedTimer) {
      armedTimer.read((r) => {
        const w = this.window;
        w.tsCompSpanSum += r.spanMs;
        w.tsCompSpanN++;
        if (r.spanMs > w.tsCompSpanMax) w.tsCompSpanMax = r.spanMs;
        for (const p of r.passes) this.accumTsPass(p.label, p.ms);
      });
    }
    return encMs;
  }

  armPresent(device: GPUDevice): GpuTimer | undefined {
    if (!PERF_MON) return undefined;
    if (!this.presTimer) this.presTimer = new GpuTimer(device, 'present');
    return this.presTimer.startSubmit() ? this.presTimer : undefined;
  }

  recordPresent(device: GPUDevice, startMs: number, armedTimer: GpuTimer | undefined): number {
    if (!PERF_MON) return 0;
    const presEncMs = performance.now() - startMs;
    onQueueDone(device.queue, () => {
      const ms = performance.now() - startMs;
      const w = this.window;
      w.presGpuSum += ms;
      w.presGpuN++;
      if (ms > w.presGpuMax) w.presGpuMax = ms;
    });
    if (armedTimer) {
      armedTimer.read((r) => {
        for (const p of r.passes) this.accumTsPass(p.label, p.ms);
      });
    }
    return presEncMs;
  }

  flushFrame(s: FramePerfSample): void {
    if (!PERF_MON) return;
    const w = this.window;
    const now = performance.now();
    if (w.lastFlush === 0) w.lastFlush = now;

    w.n++;
    w.mode = s.mode;
    if (s.roiTargetW > 0 && s.roiTargetH > 0) {
      w.roiTargetW = s.roiTargetW;
      w.roiTargetH = s.roiTargetH;
      w.roiDensity = s.roiDensity;
    }
    w.compileSum += s.compileMs;
    if (s.compileMs > w.compileMax) w.compileMax = s.compileMs;
    w.sigSum += s.sigMs;
    if (s.sigMs > w.sigMax) w.sigMax = s.sigMs;
    if (s.sigMiss) w.sigMiss++;
    if (s.recomposite) {
      w.recompN++;
      if (s.recompositeRoi) w.roiRecompN++;
      w.compEncSum += s.compEncMs;
      if (s.compEncMs > w.compEncMax) w.compEncMax = s.compEncMs;
    }
    w.presEncSum += s.presEncMs;
    if (s.presEncMs > w.presEncMax) w.presEncMax = s.presEncMs;
    w.docW = s.docW;
    w.docH = s.docH;
    w.layers = s.layers;

    if (now - w.lastFlush >= 1000 && w.n > 0) {
      const f = (x: number) => x.toFixed(2);
      const avg = (sum: number, n: number) => (n > 0 ? f(sum / n) : '-');
      const roiStr = w.mode === 'roi' ? ` roi=${w.roiTargetW}×${w.roiTargetH}@${f(w.roiDensity)}` : '';
      console.warn(
        `[Engine.render] window(${w.n}f) target=${w.docW}×${w.docH} layers=${w.layers} mode=${w.mode}${roiStr} ` +
          `recomposite=${w.recompN}/${w.n} (roi=${w.roiRecompN}) | ` +
          `compile avg=${avg(w.compileSum, w.n)} max=${f(w.compileMax)} | ` +
          `sig avg=${avg(w.sigSum, w.n)} max=${f(w.sigMax)} miss=${w.sigMiss} | ` +
          `compEnc avg=${avg(w.compEncSum, w.recompN)} max=${f(w.compEncMax)} | ` +
          `presEnc avg=${avg(w.presEncSum, w.n)} max=${f(w.presEncMax)} | ` +
          `gpu→composite avg=${avg(w.compGpuSum, w.compGpuN)} max=${f(w.compGpuMax)} | ` +
          `gpu→present avg=${avg(w.presGpuSum, w.presGpuN)} max=${f(w.presGpuMax)} (ms, GPU=latency incl. queue backlog)`,
      );
      console.warn(`[Engine.render.workingSet] ${formatWorkingSetMiB(s.workingSet.snapshot())}`);

      const passKeys = Object.keys(w.tsPass);
      if (w.tsCompSpanN > 0 || passKeys.length > 0) {
        const passStr = passKeys
          .map((k) => `${k} avg=${avg(w.tsPass[k].sum, w.tsPass[k].n)} max=${f(w.tsPass[k].max)}`)
          .join(' | ');
        console.warn(
          `[Engine.render.gpuTS] compSpan avg=${avg(w.tsCompSpanSum, w.tsCompSpanN)} max=${f(w.tsCompSpanMax)}` +
            (passStr ? ` | ${passStr}` : '') +
            ' (ms, true GPU exec, backlog-independent)',
        );
      }

      w.n = 0;
      w.compileSum = 0; w.compileMax = 0;
      w.sigSum = 0; w.sigMax = 0; w.sigMiss = 0;
      w.recompN = 0; w.roiRecompN = 0; w.compEncSum = 0; w.compEncMax = 0;
      w.presEncSum = 0; w.presEncMax = 0;
      w.compGpuSum = 0; w.compGpuN = 0; w.compGpuMax = 0;
      w.presGpuSum = 0; w.presGpuN = 0; w.presGpuMax = 0;
      w.tsCompSpanSum = 0; w.tsCompSpanN = 0; w.tsCompSpanMax = 0;
      w.tsPass = {};
      w.lastFlush = now;
    }
  }

  destroy(): void {
    this.compTimer?.destroy();
    this.compTimer = null;
    this.presTimer?.destroy();
    this.presTimer = null;
  }

  private accumTsPass(label: string, ms: number): void {
    const map = this.window.tsPass;
    const e = map[label] ?? (map[label] = { sum: 0, n: 0, max: 0 });
    e.sum += ms;
    e.n++;
    if (ms > e.max) e.max = ms;
  }
}
