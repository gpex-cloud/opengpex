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

import { EditorActions, CameraState } from '@opengpex/editor/core/types';

/**
 * CameraTransaction: Camera fast-track transaction manager for non-pointer interactions (wheel/trackpad/programmatic)
 * 
 * Parallel to InteractionTransaction, but does not depend on InteractionEvent,
 * suitable for high-frequency camera updates in React Hooks or non-Handler scenarios.
 * 
 * Usage patterns:
 *   const tx = new CameraTransaction(actions, frameId);
 *   tx.begin();           // Open fast-track session
 *   tx.override(camera);  // 60fps high-frequency override
 *   tx.commit();          // End session, fold into State
 */
export class CameraTransaction {
  private committed = false;

  constructor(
    private actions: EditorActions,
    private frameId: string,
    /**
     * Concurrency guard: reports whether a pointer gesture
     * (InteractionTransaction) is currently open. The debounced wheel commit
     * can fire while such a gesture is live; in that case this transaction
     * must NOT pull the shared volatile `interacting` flag down — the pointer
     * transaction's own teardown owns the final close.
     */
    private isPointerGestureActive?: () => boolean
  ) {}

  /**
   * Begin transaction: mark interacting, open fast-track.
   *
   * Gesture-lifecycle ownership: the volatile `interacting` flag is owned by
   * the transactions. begin() opens this camera gesture's fast-track session
   * explicitly — the buffer-write primitives no longer flip the flag as a
   * side effect.
   */
  begin() {
    this.committed = false;
    this.actions.mutateVolatile((v) => { v.activeState.interacting = true; });
    this.actions.setInteraction({ isInteracting: true });
  }

  /**
   * Override camera state at high frequency (60fps, no Undo generated)
   */
  override(camera: CameraState) {
    this.actions.fast.overrideFrame(this.frameId, { camera });
  }

  /**
   * Commit transaction: fast-track data committed to Redux + end interaction mark
   */
  commit() {
    if (this.committed) return;
    this.committed = true;
    this.actions.fast.commit(this.frameId, 'frame');
    this.actions.setInteraction({ isInteracting: false });
    // Flag teardown with concurrency guard: the landing primitive above is
    // flag-neutral, so this transaction closes its own gesture here — unless
    // a pointer gesture is still live, in which case the flag belongs to that
    // transaction's teardown.
    const pointerGestureLive = this.isPointerGestureActive?.() ?? false;
    if (!pointerGestureLive) {
      this.actions.mutateVolatile((v) => { v.activeState.interacting = false; });
    }
  }
}
