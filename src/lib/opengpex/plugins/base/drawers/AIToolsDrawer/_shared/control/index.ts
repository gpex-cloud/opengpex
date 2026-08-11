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
 * Control Sub-module — Barrel re-export.
 *
 * Contains the shared control-flow infrastructure for AI tool commands:
 *   - createAIToolStore: Factory for module-level stores
 *   - createToolCommand: Factory for run+abort command pairs (full orchestration)
 *   - createWorkerClient: Factory for Worker client singletons
 *   - inferenceQueue: GPU mutex for cross-tool serialization
 */

// ─── Store Factory ───────────────────────────────────────────────────────────

export { createAIToolStore } from './createAIToolStore';
export type { AIToolTask, AIToolStoreState, AIToolStore } from './createAIToolStore';

// ─── Tool Command Factory (includes full inference orchestration) ─────────────

export { createToolCommand } from './createToolCommand';
export type { ToolCommandConfig, ToolCommandResult, ProcessResultOutcome } from './createToolCommand';

// ─── Worker Client Factory ───────────────────────────────────────────────────

export { createWorkerClient } from './createWorkerClient';
export type { WorkerClientConfig, WorkerClient } from './createWorkerClient';

