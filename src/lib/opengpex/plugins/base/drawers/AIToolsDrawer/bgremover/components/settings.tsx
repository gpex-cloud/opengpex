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
 * BgRemoverSettingsSection — Self-contained model settings for the BG Remover tool.
 */

import { ModelSettings } from '../../_shared/ui/settings/ModelSettings';
import { MODEL_TYPE_KEY, MODEL_TYPE_NAME, BUILTIN_MODELS, DEFAULT_BG_REMOVAL_CONFIG } from '../protocols';
import type { ModelEntry } from '../../_shared/types';

export function BgRemoverSettingsSection() {
  return (
    <ModelSettings<ModelEntry>
      configKey={MODEL_TYPE_KEY}
      toolDisplayName={MODEL_TYPE_NAME}
      defaultConfig={DEFAULT_BG_REMOVAL_CONFIG}
      builtins={BUILTIN_MODELS}
      defaultNewModel={() => ({
        id: `custom-${Date.now()}`,
        name: 'Custom Model',
        modelId: '',
        size: 'Unknown',
        description: 'User-added custom model',
        builtin: false,
      })}
      getFiles={(m) => [{ filename: m.onnxFile ?? 'onnx/model.onnx', expectedBytes: m.expectedBytes }]}
      fileFields={[{ key: 'onnxFile', label: 'ONNX', placeholder: 'onnx/model.onnx' }]}
      customModelHint="Repo must contain preprocessor_config.json + config.json"
    />
  );
}
