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
 * Built-in marker registration entry point.
 *
 * Importing this module has the side effect of populating MARKER_REGISTRY in
 * declaration order (which is also the Tab-cycle order). Import it once from
 * the plugin entry (`index.ts`); consumers that read the registry at render
 * time (e.g. MarkerPanel) also import it defensively so ordering is stable
 * regardless of module evaluation order.
 */

import { MARKER_REGISTRY } from '../registry';
import { RectDefinition } from './rect';
import { ArrowDefinition } from './arrow';
import { EllipseDefinition } from './ellipse';

MARKER_REGISTRY.register(RectDefinition);
MARKER_REGISTRY.register(EllipseDefinition);
MARKER_REGISTRY.register(ArrowDefinition);

export { RectDefinition, ArrowDefinition, EllipseDefinition };
