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
 * sequence.ts — the single authority for animation-sequence orchestration.
 *
 * Playback and animated export both consume the frame table this module
 * produces. The orchestration is LAZY: the sequence membership is decided at
 * read time from the live document, never baked into per-layer metadata.
 *
 * Membership rule: a frame is an animation frame when ANY host layer carries
 * the `gifSequenceId` stamp written at GIF import time (the frame-level
 * marker). When it is, EVERY host layer joins the sequence, ordered by the
 * layer stack order (`layers.order` — the visual top-to-bottom order the
 * layers panel shows). Newly added layers (new, duplicated, pasted) therefore
 * join playback and export on the next session without any stamping or
 * renumbering step.
 *
 * Why layer-stack order is the authoritative playback order: import appends
 * frame layers in frame order, so the stack order equals the original frame
 * numbering for imported sequences (identical behavior to the retired
 * `gifFrameIndex` sort key). But the stack order is also user-editable —
 * dragging a layer re-orders the animation — which the metadata sort could
 * never honor (and duplicated layers carried a duplicate index, making that
 * order ambiguous). The stamp remains the frame-level marker and the delay
 * source; it no longer decides membership or order.
 *
 * The frame is deliberately single-sequence: each GIF import lands in its own
 * frame, so a frame with two stamped groups is not a reachable state; rather
 * than invent an attribution rule for unstamped layers, the whole stack plays
 * as one sequence.
 */

import { Frame, Layer } from '@opengpex/editor/core/types';

export interface AnimatedImageSequence {
   type: 'gif' | 'apng' | 'webp-anim';
   sequenceId: string;
   layers: Layer[];
   totalFrames: number;
   totalDuration: number; // ms
}

/** Default per-frame delay for layers without a `gifFrameDelay` stamp. */
export const DEFAULT_FRAME_DELAY_MS = 100;

/** Per-frame delay of a sequence layer: its stamp, else the default. */
export function frameDelayOf(layer: Layer): number {
   return (layer.metadata?.gifFrameDelay as number) || DEFAULT_FRAME_DELAY_MS;
}

/**
 * Detect the animation sequence of a frame, or null when the frame carries no
 * stamped layer (a plain photo/document frame — never treated as animated).
 * A frame with fewer than two host layers is not a sequence either (a single
 * frame GIF is just an image).
 */
export function detectAnimatedImageSequences(frame: Frame): AnimatedImageSequence[] {
   const hostLayers = frame.layers.order
      .map(id => frame.layers.byId[id])
      .filter((l): l is Layer => !!l && !l.hostId);

   // Frame-level marker: the import stamps every layer it creates, so any
   // stamped layer proves this frame is an animation frame. Its sequenceId
   // anchors the session identity (stable across layer additions — the id
   // does not change, so live player state keyed on it never resets).
   const sequenceId = hostLayers.find(l => l.metadata?.gifSequenceId)?.metadata?.gifSequenceId as string | undefined;
   if (!sequenceId || hostLayers.length <= 1) return [];

   const totalDuration = hostLayers.reduce((sum, l) => sum + frameDelayOf(l), 0);
   return [{
      type: 'gif',
      sequenceId,
      // Layer-stack order IS the playback order (see module doc).
      layers: hostLayers,
      totalFrames: hostLayers.length,
      totalDuration,
   }];
}
