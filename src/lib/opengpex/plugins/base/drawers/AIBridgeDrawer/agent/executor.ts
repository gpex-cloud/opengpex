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
 * Agent tool executor — dispatches tool_calls to editor commands.
 *
 * Each tool name maps to a specific `actions.adv.*` invocation.
 * Returns a JSON string result for the LLM tool message.
 *
 * Phase 1.5 Step 0: executor now receives an `AgentExecutorContext`
 * (actions + state getter) instead of bare EditorActions, enabling
 * state-aware tools like `get_editor_state`.
 */

import type { AgentToolCall } from '../adapters/types';
import type { EditorActions, Frame, Layer, EditorState } from '@opengpex/editor/core/types';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { getSkillDetail } from './skills';
import { GPEX_DOCS_API_URL } from '../protocols';

/** In-memory cache for docs search results (same query → no repeat fetch within session). */
const _docsCache = new Map<string, string>();

// ─── Shared types ────────────────────────────────────────────────────────────

/** Snapshot of editor state, captured at call time via ref. */
export interface EditorSnapshot {
  state: EditorState;
  activeFrame: Frame | null;
  activeLayer: Layer | null;
}

/** Context passed to the executor for each tool call. */
export interface AgentExecutorContext {
  actions: EditorActions;
  getEditorSnapshot: () => EditorSnapshot;
}

// ─── Executor ────────────────────────────────────────────────────────────────

/**
 * Execute a single agent tool call.
 *
 * @param toolCall  The tool call from the LLM response
 * @param ctx       Executor context (actions + state getter)
 * @returns JSON string result to send back as role:'tool' content
 */
export async function executeAgentTool(
  toolCall: AgentToolCall,
  ctx: AgentExecutorContext,
): Promise<string> {
  try {
    const args = JSON.parse(toolCall.function.arguments || '{}');
    const { actions, getEditorSnapshot } = ctx;

    switch (toolCall.function.name) {
      // ── Phase 1.5 Step 0: State query ──────────────────────────────────
      case 'get_editor_state': {
        const snap = getEditorSnapshot();
        return JSON.stringify(buildDetailedState(snap));
      }

      // ── Phase 1: Viewport Transform ────────────────────────────────────
      case 'rotate_image':
        actions.adv.viewport.transform.rotate.execute({
          direction: args.direction,
        });
        return JSON.stringify({
          success: true,
          action: `Rotated image ${args.direction}`,
        });

      case 'flip_image':
        actions.adv.viewport.transform.flip.execute({
          direction: args.axis,
        });
        return JSON.stringify({
          success: true,
          action: `Flipped image ${args.axis}`,
        });

      case 'reset_transform':
        actions.adv.viewport.transform.reset.execute();
        return JSON.stringify({
          success: true,
          action: 'Reset all transformations',
        });

      case 'fit_view':
        actions.adv.viewport.translate.fit.execute();
        return JSON.stringify({
          success: true,
          action: 'Fitted image to viewport',
        });

      case 'zoom_view': {
        const level = Math.max(0.1, Math.min(args.level ?? 1, 32));
        actions.adv.viewport.translate.zoom.execute(level);
        return JSON.stringify({
          success: true,
          action: `Zoomed to ${Math.round(level * 100)}%`,
        });
      }

      // ── Phase 1.5 阶段 A: History ──────────────────────────────────────
      case 'undo':
        actions.history.undo();
        return JSON.stringify({ success: true, action: 'Undid last action' });

      case 'redo':
        actions.history.redo();
        return JSON.stringify({ success: true, action: 'Redid last action' });

      // ── Phase 1.5 阶段 A: Selection operations ─────────────────────────
      case 'drill_selection': {
        actions.adv.layer.clip.drill.execute({ feather: 0 });
        // Exit clip mode (back to pan) — selection data stays on the frame
        // but the clip overlay is dismissed so the user sees the clean result.
        // Uses the ClipOptions exit command which properly discards any peel triplet.
        await actions.executeCommand('opengpex.options.clip_options.cmd.exit_clip_mode');
        return JSON.stringify({ success: true, action: 'Drilled selection (made selected area transparent) and exited clip mode' });
      }

      case 'invert_selection':
        await actions.executeCommand('opengpex.options.clip_options.cmd.invert_selection');
        return JSON.stringify({ success: true, action: 'Inverted selection' });

      // ── Phase 1.5 阶段 A: Canvas resize ────────────────────────────────
      case 'resize_image': {
        const snap = getEditorSnapshot();
        const frame = snap.activeFrame;
        if (!frame) return JSON.stringify({ success: false, error: 'No active frame' });
        const w = args.width ?? frame.canvas.w;
        const h = args.height ?? frame.canvas.h;
        await actions.adv.frame.resize.resample.execute({ targetDim: { w, h } });
        return JSON.stringify({ success: true, action: `Resized image to ${w}×${h}` });
      }

      case 'revert_image':
        actions.adv.frame.create.revert.execute();
        return JSON.stringify({ success: true, action: 'Reverted image to original imported state' });

      // ── Phase 1.5 阶段 A: Cross-plugin (AI Tools + Export) ─────────────
      case 'remove_background':
        await actions.executeCommand('opengpex.drawers.ai_tools.cmd.remove_bg');
        return JSON.stringify({ success: true, action: 'Background removal completed. A selection has been created around the foreground.' });

      case 'export_image': {
        // Map the tool's format arg → export MIME. Defaults to PNG (preserves
        // transparency). Passed as a one-shot command payload so it overrides
        // the UI-selected format for this export without changing the user's
        // persisted setting.
        const FORMAT_TO_MIME: Record<string, string> = {
          png: 'image/png',
          jpg: 'image/jpeg',
          webp: 'image/webp',
          avif: 'image/avif',
          tiff: 'image/tiff',
          bmp: 'image/bmp',
        };
        const fmtKey = typeof args.format === 'string' ? args.format.toLowerCase() : 'png';
        const mime = FORMAT_TO_MIME[fmtKey] || 'image/png';
        await actions.executeCommand('opengpex.drawers.image_info.cmd.download', { format: mime });
        return JSON.stringify({ success: true, action: `Image exported/downloaded as ${fmtKey.toUpperCase()}.` });
      }

      // ── Phase 1.2: Knowledge query ───────────────────────────────────────
      case 'search_docs': {
        const query: string = args.query || '';
        const cacheKey = `docs:${query}`;
        if (_docsCache.has(cacheKey)) {
          return _docsCache.get(cacheKey)!;
        }
        try {
          const res = await fetch(`${GPEX_DOCS_API_URL}/search?q=${encodeURIComponent(query)}`);
          if (!res.ok) return JSON.stringify({ success: false, error: `Docs API returned ${res.status}` });
          const data = await res.json();
          const result = JSON.stringify({ success: true, results: data.results ?? [] });
          _docsCache.set(cacheKey, result);
          return result;
        } catch (err) {
          console.error(`[Agent] search_docs fetch failed:`, err);
          return JSON.stringify({ success: false, error: `Docs API unavailable: ${(err as Error).message}` });
        }
      }

      // ── Phase 1.5 阶段 B: Skill-based Planning ─────────────────────────
      case 'get_skill': {
        const detail = getSkillDetail(args.skill_id);
        if (!detail) return JSON.stringify({ success: false, error: `Unknown skill: ${args.skill_id}` });
        return JSON.stringify(detail);
      }

      default:
        return JSON.stringify({
          success: false,
          error: `Unknown tool: ${toolCall.function.name}`,
        });
    }
  } catch (err) {
    return JSON.stringify({
      success: false,
      error: `Tool execution failed: ${(err as Error).message}`,
    });
  }
}

// ─── Detailed state builder ──────────────────────────────────────────────────

/** Build the detailed JSON payload for `get_editor_state` tool response. */
function buildDetailedState(snap: EditorSnapshot) {
  const { state, activeFrame: frame, activeLayer } = snap;
  if (!frame) {
    return { activeFrame: null, totalFrames: state.frames.order.length };
  }

  return {
    activeFrame: {
      id: frame.id,
      name: frame.name,
      canvas: { w: frame.canvas.w, h: frame.canvas.h },
      dpi: frame.dpi,
      rotation: frame.rotation,
      camera: {
        zoom: Math.round(frame.camera.k * 100) / 100,
        x: Math.round(frame.camera.x),
        y: Math.round(frame.camera.y),
      },
      activeLayerId: frame.activeLayerId,
      layers: frame.layers.order
        .map((id) => frame.layers.byId[id])
        .filter((l) => !l.role || l.role === 'host')
        .map((l) => ({
          id: l.id,
          name: l.name,
          type: l.type,
          visible: l.visible,
          locked: l.locked,
          opacity: l.opacity,
          blendMode: l.blendMode || 'source-over',
          bounding: { w: l.bounding.w, h: l.bounding.h },
          position: { cx: Math.round(l.cx), cy: Math.round(l.cy) },
          isActive: l.id === activeLayer?.id,
        })),
      selection: getClipBox(frame)
        ? { tool: frame.latestClipTool, hasSelection: true }
        : { hasSelection: false },
    },
    totalFrames: state.frames.order.length,
  };
}
