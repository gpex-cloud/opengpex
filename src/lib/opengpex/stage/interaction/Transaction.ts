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
 * Transaction lifecycle states.
 * - idle: created but not yet started
 * - active: in-progress, accepting update() calls
 * - committed: successfully finalized to Redux
 * - aborted: rolled back, volatile overrides cleared
 */
export type TransactionState = 'idle' | 'active' | 'committed' | 'aborted';

/**
 * InteractionTransaction: Interaction lifecycle manager
 * Encapsulates the underlying high-frequency fast/slow track separation states (Volatile / Redux) into a simple transaction model.
 *
 * State machine: idle → active → committed | aborted
 * - begin() transitions idle → active
 * - commit() transitions active → committed (idempotent: no-op if not active)
 * - abort() transitions active → aborted (rolls back volatile overrides)
 */
export class InteractionTransaction {
  private _state: TransactionState = 'idle';
  private activeFrameId: string | null = null;
  
  // Track what was modified during this transaction
  private hasFrameUpdates = false;
  private hasLayerUpdates = false;

  constructor(private e: InteractionEvent) {}

  /** Current transaction state */
  get state(): TransactionState { return this._state; }

  /** Whether the transaction is in active state (accepting updates) */
  get isActive(): boolean { return this._state === 'active'; }

  /**
   * Begin transaction: mark start of interaction
   * @param silent If true, does not trigger SIGNAL_COMMIT (no Undo Checkpoint, commonly used for pan/zoom)
   * @throws If called when not in 'idle' state
   */
  begin(silent: boolean = false) {
    if (this._state !== 'idle') {
      throw new Error(`[InteractionTransaction] Cannot begin() in state "${this._state}"`);
    }

    this._state = 'active';
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
   * No-op if transaction is not active (logs warning in dev).
   */
  update(props: Record<string, unknown>, type: 'layer' | 'frame' = 'layer', targetId?: string) {
    if (this._state !== 'active') {
      if (this._state !== 'idle') {
        // Only warn for post-terminal states (committed/aborted), not idle (which would be a programming error caught elsewhere)
        console.warn(`[InteractionTransaction] update() ignored in state "${this._state}"`);
      }
      return;
    }
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
   * Idempotent: calling commit() on an already committed/aborted transaction is a safe no-op.
   */
  commit() {
    if (this._state !== 'active') {
      // Idempotent: already committed or aborted — silently return
      if (this._state !== 'idle') {
      }
      return;
    }

    this._state = 'committed';

    if (this.hasLayerUpdates) {
      this.e.actions.fast.commit(null, 'layers');
    }
    if (this.hasFrameUpdates) {
      this.e.actions.fast.commit(this.activeFrameId, 'frame');
    }

    this.e.actions.setInteraction({ isInteracting: false });
    this.activeFrameId = null;
  }

  /**
   * Abort transaction: roll back volatile state without writing to Redux.
   * Used when user cancels an interaction (e.g., Esc key) or an async operation fails.
   * Idempotent: calling abort() on an already committed/aborted transaction is a safe no-op.
   */
  abort() {
    if (this._state !== 'active') {
      // Idempotent: already committed or aborted — silently return
      return;
    }

    this._state = 'aborted';

    // Clear all volatile overrides (rolls back visual state to pre-interaction)
    this.e.actions.fast.reset();
    this.e.actions.setInteraction({ isInteracting: false });
    this.activeFrameId = null;
  }
}
