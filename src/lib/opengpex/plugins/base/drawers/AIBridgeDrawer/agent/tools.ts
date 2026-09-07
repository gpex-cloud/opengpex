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
 * Agent tool definitions.
 *
 * Phase 1: Viewport Transform commands (synchronous, zero failure risk).
 * Phase 1.5 Step 0: `get_editor_state` for detailed state queries.
 *
 * Each tool aligns with a user-level goal, not an internal step.
 */

import type { AgentToolDef } from '../adapters/types';
import { SKILL_IDS } from './skills';

export const AGENT_TOOLS: AgentToolDef[] = [
  // ── Phase 1.5 Step 0: State query ──────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_editor_state',
      description:
        'Get detailed info about the current editor state including all frames, layers, dimensions, selections, and camera. Use this when you need specifics beyond what the state summary provides.',
      parameters: { type: 'object', properties: {} },
    },
  },
  // ── Phase 1: Viewport Transform ────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'rotate_image',
      description:
        'Rotate the current image/frame by 90 degrees. Use this when the user wants to rotate, turn, or change the orientation of the image.',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['left', 'right'],
            description:
              'Rotation direction. "left" = 90° counter-clockwise, "right" = 90° clockwise.',
          },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'flip_image',
      description:
        'Flip/mirror the current image. Use this when the user wants to mirror, flip, or reverse the image.',
      parameters: {
        type: 'object',
        properties: {
          axis: {
            type: 'string',
            enum: ['horizontal', 'vertical'],
            description:
              '"horizontal" = left-right mirror, "vertical" = top-bottom mirror.',
          },
        },
        required: ['axis'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reset_transform',
      description:
        'Reset all rotation and flip transformations back to the original orientation.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fit_view',
      description:
        'Fit the image to the viewport so the entire image is visible.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'zoom_view',
      description:
        'Zoom the viewport to a specific level. Use this when the user wants to zoom in, zoom out, or set a specific zoom percentage.',
      parameters: {
        type: 'object',
        properties: {
          level: {
            type: 'number',
            description:
              'Zoom level as a multiplier. 1.0 = 100% (actual size), 2.0 = 200%, 0.5 = 50%. Common values: 0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0.',
          },
        },
        required: ['level'],
      },
    },
  },
  // ── Phase 1.5 阶段 A: History ──────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'undo',
      description: 'Undo the last editing action on the current frame.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'redo',
      description: 'Redo the last undone action on the current frame.',
      parameters: { type: 'object', properties: {} },
    },
  },
  // ── Phase 1.5 阶段 A: Selection operations ─────────────────────────────
  {
    type: 'function',
    function: {
      name: 'drill_selection',
      description: 'Delete the pixels inside the current selection, making them transparent. Automatically exits clip mode afterwards (selection data is preserved). Requires an active selection.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'invert_selection',
      description: 'Invert (flip) the current selection so that selected and unselected areas swap. Requires an active selection.',
      parameters: { type: 'object', properties: {} },
    },
  },
  // ── Phase 1.5 阶段 A: Canvas resize ────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'resize_image',
      description: 'Resize/resample the current image to new dimensions. This resamples all layers.',
      parameters: {
        type: 'object',
        properties: {
          width: { type: 'number', description: 'New width in pixels.' },
          height: { type: 'number', description: 'New height in pixels.' },
        },
        required: ['width', 'height'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'revert_image',
      description: 'Revert the current image back to its original imported state, discarding ALL edits. This is NOT undoable. IMPORTANT: When the user says "undo", "go back", "回退", or "revert last change", they almost certainly want the undo tool instead. Only use revert_image when the user EXPLICITLY asks to reset/restore to the original imported image AND you have confirmed this is their intent (e.g. "Are you sure? This will discard all edits and cannot be undone.").',
      parameters: { type: 'object', properties: {} },
    },
  },
  // ── Phase 1.5 阶段 A: Cross-plugin (AI Tools + Export) ─────────────────
  {
    type: 'function',
    function: {
      name: 'remove_background',
      description: 'Run AI background detection on the current image. This creates a FOREGROUND selection (selects the subject, not the background). To make the background transparent, you MUST call invert_selection first (to flip the selection to the background), then drill_selection (to delete the background pixels). Always chain all three calls: remove_background → invert_selection → drill_selection.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'export_image',
      description: 'Export/download the current image as a file. Specify the format explicitly when the user asks for one (e.g. "export as PNG"). Defaults to PNG when unspecified. PNG is best for images with transparency; JPG for photos without transparency.',
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            enum: ['png', 'jpg', 'webp', 'avif', 'tiff', 'bmp'],
            description: 'Output file format. Defaults to "png" (which preserves transparency). Use "jpg" for smaller photos without transparency.',
          },
        },
      },
    },
  },
  // ── Phase 1.2: Knowledge query ──────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'search_docs',
      description:
        'Search OpenGPEX documentation for information about features, tools, shortcuts, workflows, etc. Use this when the user asks "how do I…", "what is…", or "where is…" questions about OpenGPEX itself.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search keywords (e.g. "undo shortcut", "selection tools", "export png").',
          },
        },
        required: ['query'],
      },
    },
  },
  // ── Phase 1.5 阶段 B: Skill-based Planning ─────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_skill',
      description:
        'Get detailed steps for a named skill/workflow. Use this when the user\'s goal matches an Available Skill from the system instructions. Returns: goal, prerequisites, recommended steps, and success criteria.',
      parameters: {
        type: 'object',
        properties: {
          skill_id: {
            type: 'string',
            enum: SKILL_IDS,
            description: 'The skill identifier to look up.',
          },
        },
        required: ['skill_id'],
      },
    },
  },
];
