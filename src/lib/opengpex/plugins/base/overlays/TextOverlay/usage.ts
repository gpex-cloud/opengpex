/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

'use client';

import { CraftDrawerAPI } from '../../drawers/CraftDrawer/protocols';
import { registerLayerOverlayUsage } from '../LayerOverlay/usage';
import { TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID } from './protocols';

/**
 * TextOverlay's LayerOverlay usage: pre-edit text craft force-shows text
 * outlines + gizmos; an active editing session suppresses hover outlines
 * (the editing box carries its own frame) instead.
 *
 * Registered once at module scope; `resolve` is a pure function of signals.
 */
registerLayerOverlayUsage({
  id: 'text',
  resolve({ signals }) {
    const editingLayerId = signals[TEXT_OVERLAY_SIGNAL_EDITING_TEXT_LAYER_ID];
    if (typeof editingLayerId === 'string' && editingLayerId) {
      return { suppressHover: true };
    }
    if (signals[CraftDrawerAPI.signals.activeCraft] === 'text') {
      return { gizmoTypes: ['text'] };
    }
    return null;
  },
});
