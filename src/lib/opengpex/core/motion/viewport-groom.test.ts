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
 * viewport-groom.test.ts — `onGroomed` must fire on every code path.
 *
 * WHY: `Viewport` gates the visibility of the ENTIRE stage — WebGPU canvas and
 * SVG checkerboard backdrop alike — on `isGroomed`:
 *
 *     const isReady = isGroomed && imagesLoaded;
 *     <div style={{ opacity: isReady ? 1 : 0 }}>   // canvas + backdrop inside
 *
 * `isGroomed` starts false and is only ever flipped by `onGroomed`. The owning
 * `useLayoutEffect` depends on `[frame, ...]`, so if the first invocation after
 * a mount fails to call `onGroomed`, nothing re-triggers it and the stage stays
 * permanently dark.
 *
 * The reported bug: with several frames open, closing one remounts `Viewport`
 * (its `key` is `activeFrameId`), resetting `isGroomed` to false. The close
 * gesture can leave `activeState.interacting === true`, and the sync function
 * bailed out before releasing the gate — canvas AND checkerboard both invisible.
 *
 * gsap is stubbed: we assert the CONTRACT (gate always released), not tweens.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('gsap', () => {
  const noop = () => ({});
  return {
    default: {
      set: noop,
      to: noop,
      fromTo: noop,
      killTweensOf: noop,
      timeline: () => ({ to: noop, set: noop, fromTo: noop }),
      ticker: { add: noop, remove: noop, sleep: noop, wake: noop, fps: noop },
      registerPlugin: noop,
    },
  };
});

import { Motion } from './index';

type SyncParams = Parameters<typeof Motion.syncViewportGeometry>[0];

/** Baseline args for a settled, already-bootstrapped viewport. */
function makeParams(overrides: Partial<SyncParams> = {}): SyncParams {
  const el = () => ({ style: {} }) as unknown as HTMLElement;
  return {
    stage: el(),
    artboard: el(),
    current: { x: 0, y: 0, k: 1, w: 800, h: 600, rotation: 0, id: 'frame-A' },
    prev: { k: 1, id: 'frame-A', w: 800, h: 600 },
    interaction: {
      isInteracting: false,
      rotationChanged: false,
      isRotationSwap: false,
      delta: 0,
    },
    ...overrides,
  };
}

describe('Motion.syncViewportGeometry — onGroomed visibility gate', () => {
  let onGroomed: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    onGroomed = vi.fn<() => void>();
  });

  it('releases the gate while interacting (the close-a-frame regression)', () => {
    // Frame just remounted (prev.k=0, different prev.id) AND a pointer
    // interaction is still flagged from the close gesture. Pre-fix this
    // returned early and the stage stayed at opacity:0 forever.
    Motion.syncViewportGeometry(
      makeParams({
        interaction: {
          isInteracting: true,
          rotationChanged: false,
          isRotationSwap: false,
          delta: 0,
        },
        prev: { k: 0, id: 'frame-B', w: 800, h: 600 },
        onGroomed,
      }),
    );

    expect(
      onGroomed,
      'interacting must not suppress the visibility gate — animation is ' +
        'skipped (the ticker drives the transform), but the stage must show.',
    ).toHaveBeenCalled();
  });

  it('releases the gate when stage/artboard refs are not yet attached', () => {
    Motion.syncViewportGeometry(makeParams({ stage: null, onGroomed }));
    expect(onGroomed).toHaveBeenCalled();

    onGroomed.mockClear();
    Motion.syncViewportGeometry(makeParams({ artboard: null, onGroomed }));
    expect(onGroomed).toHaveBeenCalled();
  });

  it('releases the gate on the steady-state update path', () => {
    Motion.syncViewportGeometry(makeParams({ onGroomed }));
    expect(onGroomed).toHaveBeenCalled();
  });

  it('releases the gate on frame switch and on initial load', () => {
    // Frame switch: prev.id !== current.id
    Motion.syncViewportGeometry(
      makeParams({ prev: { k: 1, id: 'frame-B', w: 800, h: 600 }, onGroomed }),
    );
    expect(onGroomed).toHaveBeenCalled();

    // Initial load: prev.k === 0
    onGroomed.mockClear();
    Motion.syncViewportGeometry(
      makeParams({ prev: { k: 0, id: 'frame-A', w: 800, h: 600 }, onGroomed }),
    );
    expect(onGroomed).toHaveBeenCalled();
  });

  it('is exhaustive: gate fires for every combination of entry conditions', () => {
    // Brute-force the decision space so no future branch can silently skip the
    // gate. Every permutation must release visibility.
    for (const isInteracting of [true, false]) {
      for (const hasStage of [true, false]) {
        for (const prevK of [0, 1]) {
          for (const prevId of ['frame-A', 'frame-B']) {
            for (const sizeChanged of [true, false]) {
              for (const isRotationSwap of [true, false]) {
                const cb = vi.fn<() => void>();
                Motion.syncViewportGeometry(
                  makeParams({
                    ...(hasStage ? {} : { stage: null }),
                    prev: {
                      k: prevK,
                      id: prevId,
                      w: sizeChanged ? 640 : 800,
                      h: sizeChanged ? 480 : 600,
                    },
                    interaction: {
                      isInteracting,
                      rotationChanged: false,
                      isRotationSwap,
                      delta: 0,
                    },
                    onGroomed: cb,
                  }),
                );
                expect(
                  cb,
                  `gate not released for interacting=${isInteracting} ` +
                    `hasStage=${hasStage} prevK=${prevK} prevId=${prevId} ` +
                    `sizeChanged=${sizeChanged} rotSwap=${isRotationSwap}`,
                ).toHaveBeenCalled();
              }
            }
          }
        }
      }
    }
  });

  it('tolerates a missing onGroomed callback', () => {
    expect(() => Motion.syncViewportGeometry(makeParams())).not.toThrow();
    expect(() =>
      Motion.syncViewportGeometry(makeParams({ stage: null })),
    ).not.toThrow();
  });
});
