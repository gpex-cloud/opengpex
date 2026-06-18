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

export const PLUGIN_ID = 'options.clip_options';
export const PLUGIN_AUTHOR = 'opengpex';

export const CMD_RE_CANVAS_TOGGLE = 'cmd.re_canvas.toggle';
export const CMD_RE_CANVAS_APPLY = 'cmd.re_canvas.apply';
export const CMD_TOGGLE_MODE = 'cmd.toggle_mode';
export const CMD_SET_ASPECT = 'cmd.set_aspect';
export const CMD_RESET_ASPECT = 'cmd.reset_aspect';
export const CMD_BRANCH = 'cmd.branch.create';
export const CMD_RESET_BOX = 'cmd.box.reset';
export const CMD_TOGGLE_ANTI_ALIAS = 'cmd.anti_alias.toggle';

export const SIGNAL_RE_CANVAS = 'signal.re_canvas.active';


// Cross-plugin reference UIDs (for use by external consumers via actions.executeCommand)
export const CLIP_OPTIONS_CMD_TOGGLE_MODE = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_TOGGLE_MODE}`;
export const CLIP_OPTIONS_CMD_RESET_BOX = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_RESET_BOX}`;
export const CLIP_OPTIONS_CMD_BRANCH = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_BRANCH}`;
export const CLIP_OPTIONS_SIGNAL_RE_CANVAS = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_RE_CANVAS}`;

