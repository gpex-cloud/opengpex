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
 * SegSettingsSection — Self-contained model settings for the Segmentation tool.
 */

import { ModelSettings } from '../../_shared/ui/settings/ModelSettings';
import {
  MODEL_TYPE_KEY,
  MODEL_TYPE_NAME,
  BUILTIN_SEG_MODELS,
  DEFAULT_SEG_CONFIG,
  DEFAULT_SEG_ENCODER_FILE,
  DEFAULT_SEG_DECODER_FILE,
  getSegModelFiles,
} from '../protocols';
import type { SegModelEntry } from '../protocols';

export function SegSettingsSection() {
  return (
    <ModelSettings<SegModelEntry>
      configKey={MODEL_TYPE_KEY}
      toolDisplayName={MODEL_TYPE_NAME}
      defaultConfig={DEFAULT_SEG_CONFIG}
      builtins={BUILTIN_SEG_MODELS}
      defaultNewModel={() => ({
        id: `custom-seg-${Date.now()}`,
        name: 'Custom SAM Model',
        modelId: '',
        size: 'Unknown',
        description: 'User-added custom segmentation model',
        builtin: false,
        type: 'interactive' as const,
      })}
      getFiles={(m) => getSegModelFiles(m)}
      getBadge={(m) => m.type === 'auto' ? 'Auto' : 'Interactive'}
      fileFields={[
        { key: 'encoderFile', label: 'Encoder', placeholder: DEFAULT_SEG_ENCODER_FILE },
        { key: 'decoderFile', label: 'Decoder', placeholder: DEFAULT_SEG_DECODER_FILE },
      ]}
    />
  );
}
