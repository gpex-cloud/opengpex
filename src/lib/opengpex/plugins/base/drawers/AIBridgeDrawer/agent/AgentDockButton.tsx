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
'use client';

/**
 * AgentDockButton — contributed to DOCK_ACTIONS slot in TabDock.
 *
 * Renders a small icon button; clicking toggles the floating AgentChatPanel.
 * When no agent is configured, the button is dimmed with a guiding tooltip.
 *
 * The chat panel slides up from the dock with a spring animation.
 * Positioning: relative wrapper + absolute panel, offset computed from the
 * dock element so the panel clears the entire TabDock — not just the button.
 */

import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Bot } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { usePluginSelfConfig } from '@opengpex/editor/core/context';
import Tooltip from '@opengpex/editor/widgets/Tooltip';
import EditorPortal from '@opengpex/editor/widgets/Portal';
import type { AIBridgeConfig, AgentDef } from '../protocols';
import { AgentChatPanel } from './AgentChatPanel';

export function AgentDockButton() {
  const [config] = usePluginSelfConfig<AIBridgeConfig>();
  const [open, setOpen] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Panel position in viewport (fixed) coordinates — anchored at its bottom edge.
  const [panelPos, setPanelPos] = useState<{ left: number; bottom: number }>({ left: 0, bottom: 0 });

  const hasAgent = useMemo(() => {
    const agents: AgentDef[] = config.agents || [];
    return !!agents.find((a) => a.id === config.activeAgentId);
  }, [config.agents, config.activeAgentId]);

  const tooltip = hasAgent
    ? 'AI Agent'
    : 'No Agent configured — go to Settings → AI Bridge → Agents';

  const PANEL_W = 440;

  /**
   * Compute the panel's viewport position synchronously — called before opening.
   * The panel is rendered through a Portal (to escape the dock's CSS transform,
   * which would otherwise neutralize its backdrop-blur glass effect), so it is
   * positioned with `fixed` coordinates derived from the dock rect.
   */
  const computeOffset = useCallback(() => {
    if (!wrapRef.current) return;
    const dock = wrapRef.current.closest('#editor-tab-dock') as HTMLElement | null;
    const anchor = (dock ?? wrapRef.current).getBoundingClientRect();

    // Horizontal: centre the panel on the dock, clamp to the viewport (8px margin).
    const centreX = anchor.left + anchor.width / 2;
    let left = centreX - PANEL_W / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - PANEL_W - 8));

    // Vertical: panel bottom sits 12px above the dock's top edge.
    const bottom = window.innerHeight - anchor.top + 12;

    setPanelPos({ left, bottom });
  }, []);

  const togglePanel = useCallback(() => {
    if (!hasAgent) return;
    setOpen((prev) => {
      if (!prev) computeOffset();
      return !prev;
    });
  }, [hasAgent, computeOffset]);

  // Listen for ⌘K shortcut (dispatched as custom event from the command)
  useEffect(() => {
    window.addEventListener('editor:toggle-agent-chat', togglePanel);
    return () => window.removeEventListener('editor:toggle-agent-chat', togglePanel);
  }, [togglePanel]);

  // Hide entirely when agents are disabled in settings
  if ((config.enableAgents ?? true) === false) return null;

  return (
    <div ref={wrapRef} className="relative">
      <Tooltip content={tooltip} align="center">
        <button
          onClick={togglePanel}
          className={`flex items-center justify-center w-8 h-8 rounded-full transition-all ${
            open
              ? 'bg-amber-500/20 text-amber-500 shadow-lg shadow-amber-500/10'
              : hasAgent
                ? 'text-[var(--text-muted)] hover:text-amber-500 hover:bg-amber-500/10'
                : 'text-[var(--text-muted)] opacity-40 cursor-not-allowed'
          }`}
        >
          <Bot size={16} />
        </button>
      </Tooltip>

      {/* Floating chat panel — portaled out of the dock so its backdrop-blur
          glass effect is not neutralized by the dock's CSS transform.
          The glass shell (bg/blur/border/shadow) lives on this animated
          wrapper: an element may carry both `transform` and `backdrop-filter`
          and still blur correctly — only a *transformed ancestor* defeats it. */}
      <EditorPortal>
        <AnimatePresence>
          {open && hasAgent && (
            <motion.div
              className="fixed z-[9999] pointer-events-auto rounded-2xl overflow-hidden border border-[var(--border-subtle)] bg-[var(--bg-panel)]/85 backdrop-blur-xl shadow-2xl shadow-black/40"
              style={{ left: panelPos.left, bottom: panelPos.bottom }}
              initial={{ opacity: 0, y: 24, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.96 }}
              transition={{ type: 'spring', stiffness: 420, damping: 28 }}
            >
              <AgentChatPanel onClose={() => setOpen(false)} hintDismissed={hintDismissed} onDismissHint={() => setHintDismissed(true)} />
            </motion.div>
          )}
        </AnimatePresence>
      </EditorPortal>
    </div>
  );
}
