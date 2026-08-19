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

'use client';

import { useMemo } from 'react';
import { useEditorState } from '@opengpex/editor/core/context';
import * as P from '../protocols';

const MOUNT_TIME = Date.now();

/**
 * useHistoryMetrics: Builds HistoryMoment[] from per-frame history steps.
 * Only re-computes when history step count changes.
 */
export const useHistoryMetrics = (isEnabled: boolean): P.HistoryMoment[] => {
  const { state } = useEditorState();

  return useMemo(() => {
    if (!isEnabled) return [];

    // Per-frame history stores Immer patches rather than full frame snapshots.
    // Build history moments from the per-frame step metadata, estimating size from patch payloads.
    const allSteps = Object.entries(state.history.byFrameId).flatMap(([fId, fh]) =>
      fh.past.map(step => ({ ...step, frameId: fId }))
    );

    return allSteps.slice(-10).reverse().map((step, i) => {
      // Estimate patch storage size (serialized JSON of undo + redo patches)
      const patchSize = (
        JSON.stringify(step.undoPatches || []).length +
        JSON.stringify(step.redoPatches || []).length
      );
      return {
        id: step.id,
        timestamp: MOUNT_TIME - (i * 1000),
        label: step.name || `Step #${allSteps.length - i}`,
        thumbnailUrl: '',
        assets: [],
        totalSize: patchSize,
        exclusiveSize: patchSize
      };
    });
  }, [isEnabled, state.history.byFrameId]);
};
