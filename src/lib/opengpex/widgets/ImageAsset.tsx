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

import React from 'react';
import { useEditorServices } from '@opengpex/editor/core/context';

interface ImageAssetProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  assetId?: string;
  src?: string;
  fallback?: React.ReactNode;
}

/**
 * ImageAsset: Smart asset image component
 * Automatically handles persisted Asset ID addressing, supporting expired Blob URL recovery.
 */
const ImageAsset = ({ assetId, src, fallback, ...props }: ImageAssetProps) => {
  const { assets } = useEditorServices();
  
  const resolvedSrc = assets.resolve(assetId, src);

  if (!resolvedSrc && fallback) {
    return <>{fallback}</>;
  }

  return (
    <img 
      src={resolvedSrc} 
      {...props} 
      alt={props.alt || ''} 
    />
  );
};

export default ImageAsset;
