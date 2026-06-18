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

import { InteractionEvent, VolatileState } from '@opengpex/editor/core/types';

/**
 * InteractionTransaction: Interaction lifecycle manager
 * Encapsulates the underlying high-frequency fast/slow track separation states (Volatile / Redux) into a simple transaction model.
 */
export class InteractionTransaction {
  private activeFrameId: string | null = null;
  
  // Track what was modified during this transaction
  private hasFrameUpdates = false;
  private hasLayerUpdates = false;

  constructor(private e: InteractionEvent) {}

  /**
   * Begin transaction: mark start of interaction
   * @param silent If true, does not trigger SIGNAL_COMMIT (no Undo Checkpoint, commonly used for pan/zoom)
   */
  begin(silent: boolean = false) {
    this.activeFrameId = this.e.activeFrame.id;
    this.hasFrameUpdates = false;
    this.hasLayerUpdates = false;

    // Triggers underlying SIGNAL_COMMIT to generate Undo record and sets interacting = true
    if (!silent) {
      this.e.actions.fast.signal(this.activeFrameId);
    } else {
      // If silent, manually set interacting = true to open fast-track
      this.e.actions.mutateVolatile((v: VolatileState) => { v.activeState.interacting = true; });
    }
    this.e.actions.setInteraction({ isInteracting: true });
  }

  /**
   * Update transaction intermediate state: write data to 60fps volatile track
   * Bypasses Redux completely to guarantee dragging performance.
   */
  update(props: Record<string, unknown>, type: 'layer' | 'frame' = 'layer', targetId?: string) {
    if (!this.activeFrameId) return;

    if (type === 'layer' && targetId) {
      this.hasLayerUpdates = true;
      this.e.actions.fast.override(this.activeFrameId, targetId, props, 'layer');
    } else if (type === 'frame') {
      this.hasFrameUpdates = true;
      this.e.actions.fast.override(this.activeFrameId, this.activeFrameId, props, 'frame');
    }
  }

  /**
   * Commit transaction: commit final fast-track data to Redux main state (Slow Track)
   */
  commit() {
    if (!this.activeFrameId) return;

    if (this.hasLayerUpdates) {
      this.e.actions.fast.commit(null, 'layers');
    }
    if (this.hasFrameUpdates) {
      this.e.actions.fast.commit(this.activeFrameId, 'frame');
    }

    this.e.actions.setInteraction({ isInteracting: false });
    this.activeFrameId = null;
  }
}

