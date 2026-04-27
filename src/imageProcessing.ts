import type { AssetSelection, CutterSettings, DetectionSettings, RGB } from './types';

export type ProcessedAsset = {
  fileName: string;
  selection: AssetSelection;
  canvas: HTMLCanvasElement;
};

export type OpaqueBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const colorDistance = (data: Uint8ClampedArray, index: number, color: RGB) => {
  const dr = data[index] - color.r;
  const dg = data[index + 1] - color.g;
  const db = data[index + 2] - color.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
};

const makeCanvas = (width: number, height: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
};

export const cropSelection = (
  image: HTMLImageElement,
  selection: AssetSelection,
): HTMLCanvasElement => {
  const sourceSelection = normalizeSelection(selection);
  const source = makeCanvas(sourceSelection.width, sourceSelection.height);
  const ctx = source.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas context could not be created.');

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    image,
    sourceSelection.x,
    sourceSelection.y,
    sourceSelection.width,
    sourceSelection.height,
    0,
    0,
    sourceSelection.width,
    sourceSelection.height,
  );

  return source;
};

export const applyTransparency = (
  source: HTMLCanvasElement,
  settings: CutterSettings,
): HTMLCanvasElement => {
  const canvas = makeCanvas(source.width, source.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas context could not be created.');

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0);
  if (settings.mode === 'none') return canvas;

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = imageData;

  if (settings.mode === 'color') {
    removeSimilarColors(data, settings.backgroundColor, settings.tolerance);
  } else {
    removeConnectedEdgeBackground(data, width, height, settings.backgroundColor, settings.tolerance);
  }

  if (settings.reduceFringe) reduceColorFringe(data, settings.backgroundColor);
  if (settings.removeSpecks) removeSmallOpaqueSpecks(data, width, height);
  if (settings.feather > 0) featherAlpha(data, width, height, settings.feather);

  ctx.putImageData(imageData, 0, 0);
  return canvas;
};

const removeSimilarColors = (
  data: Uint8ClampedArray,
  backgroundColor: RGB,
  tolerance: number,
) => {
  for (let i = 0; i < data.length; i += 4) {
    if (colorDistance(data, i, backgroundColor) <= tolerance) {
      data[i + 3] = 0;
    }
  }
};

const removeConnectedEdgeBackground = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  backgroundColor: RGB,
  tolerance: number,
) => {
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];

  const enqueue = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const pixel = y * width + x;
    if (visited[pixel]) return;
    const i = pixel * 4;
    if (colorDistance(data, i, backgroundColor) > tolerance) return;
    visited[pixel] = 1;
    queue.push(pixel);
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  while (queue.length > 0) {
    const pixel = queue.shift()!;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    data[pixel * 4 + 3] = 0;
    enqueue(x + 1, y);
    enqueue(x - 1, y);
    enqueue(x, y + 1);
    enqueue(x, y - 1);
  }
};

const reduceColorFringe = (data: Uint8ClampedArray, backgroundColor: RGB) => {
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    if (alpha <= 0 || alpha >= 1) continue;

    // Semi-transparent edge pixels are nudged away from the sampled background
    // color to reduce visible halos on dark or colored surfaces.
    data[i] = clamp((data[i] - backgroundColor.r * (1 - alpha)) / alpha);
    data[i + 1] = clamp((data[i + 1] - backgroundColor.g * (1 - alpha)) / alpha);
    data[i + 2] = clamp((data[i + 2] - backgroundColor.b * (1 - alpha)) / alpha);
  }
};

const removeSmallOpaqueSpecks = (data: Uint8ClampedArray, width: number, height: number) => {
  const copy = new Uint8ClampedArray(data);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const pixel = y * width + x;
      const alpha = copy[pixel * 4 + 3];
      if (alpha === 0) continue;

      let opaqueNeighbors = 0;
      for (let yy = -1; yy <= 1; yy += 1) {
        for (let xx = -1; xx <= 1; xx += 1) {
          if (xx === 0 && yy === 0) continue;
          const neighbor = ((y + yy) * width + (x + xx)) * 4;
          if (copy[neighbor + 3] > 20) opaqueNeighbors += 1;
        }
      }

      if (opaqueNeighbors <= 1) data[pixel * 4 + 3] = 0;
    }
  }
};

const featherAlpha = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
) => {
  const original = new Uint8ClampedArray(data);
  const r = Math.max(1, Math.round(radius));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (original[index + 3] === 0) continue;

      let nearTransparent = false;
      for (let yy = -r; yy <= r && !nearTransparent; yy += 1) {
        for (let xx = -r; xx <= r; xx += 1) {
          const nx = x + xx;
          const ny = y + yy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
            nearTransparent = true;
            break;
          }
          if (original[(ny * width + nx) * 4 + 3] === 0) {
            nearTransparent = true;
            break;
          }
        }
      }

      if (nearTransparent) data[index + 3] = Math.min(data[index + 3], 210);
    }
  }
};

export const fitToOutput = (
  source: HTMLCanvasElement,
  settings: CutterSettings,
): HTMLCanvasElement => {
  const bounds = settings.autoTrim ? getOpaqueBounds(source) : null;
  const sx = bounds?.x ?? 0;
  const sy = bounds?.y ?? 0;
  const sw = bounds?.width ?? source.width;
  const sh = bounds?.height ?? source.height;
  const shouldPixelate = settings.pixelArtMode || settings.resizeMethod === 'nearest';
  const padding = Math.max(0, Math.round(settings.padding));
  const stagingWidth = sw + padding * 2;
  const stagingHeight = sh + padding * 2;
  const staging = makeCanvas(stagingWidth, stagingHeight);
  const stagingCtx = staging.getContext('2d');
  if (!stagingCtx) throw new Error('Canvas context could not be created.');

  stagingCtx.imageSmoothingEnabled = false;
  const stageDx = padding;
  const stageDy = padding;
  stagingCtx.drawImage(source, sx, sy, sw, sh, stageDx, stageDy, sw, sh);

  const scaleFactor = getScaleFactor(settings.scaleMode);
  const targetWidth = scaleFactor ? Math.max(1, Math.round(staging.width * scaleFactor)) : settings.exportSize.width;
  const targetHeight = scaleFactor ? Math.max(1, Math.round(staging.height * scaleFactor)) : settings.exportSize.height;
  const output = makeCanvas(targetWidth, targetHeight);
  const ctx = output.getContext('2d');
  if (!ctx) throw new Error('Canvas context could not be created.');

  ctx.imageSmoothingEnabled = !shouldPixelate;
  if (!shouldPixelate) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(staging, 0, 0, staging.width, staging.height, 0, 0, output.width, output.height);
  return output;
};

export const getOpaqueBounds = (source: HTMLCanvasElement): OpaqueBounds | null => {
  const ctx = source.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const { data, width, height } = ctx.getImageData(0, 0, source.width, source.height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] <= 8) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
};

export const getTransparentCropBounds = (
  image: HTMLImageElement,
  selection: AssetSelection,
  settings: CutterSettings,
): OpaqueBounds | null => {
  const cropped = cropSelection(image, selection);
  const transparent = applyTransparency(cropped, settings);
  return getOpaqueBounds(transparent);
};

export const processAsset = (
  image: HTMLImageElement,
  selection: AssetSelection,
  settings: CutterSettings,
): ProcessedAsset => {
  const cropped = cropSelection(image, selection);
  const transparent = applyTransparency(cropped, settings);
  const canvas = fitToOutput(transparent, settings);
  return {
    fileName: `${selection.name || selection.id}.png`,
    selection,
    canvas,
  };
};

export const detectAssetSelections = (
  image: HTMLImageElement,
  settings: CutterSettings,
  detection: DetectionSettings,
): AssetSelection[] => {
  const canvas = makeCanvas(image.naturalWidth, image.naturalHeight);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = imageData;
  const mask = settings.mode === 'edge'
    ? buildEdgeForegroundMask(data, width, height, settings.backgroundColor, settings.tolerance)
    : buildColorForegroundMask(data, settings.backgroundColor, settings.tolerance, settings.mode === 'none');
  const boxes = findConnectedBoxes(mask, width, height, detection.minArea);
  const merged = mergeBoxes(boxes, detection.mergeDistance);
  const padded = merged.map((box) => padBox(box, detection.padding, width, height));

  return padded.map((box, index) => ({
    id: `asset_${String(index + 1).padStart(3, '0')}`,
    name: `asset_${String(index + 1).padStart(3, '0')}`,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
  }));
};

export const canvasToBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG export failed.'));
    }, 'image/png');
  });

export const createPreviewSheet = async (assets: ProcessedAsset[], settings: CutterSettings) => {
  const cell = 160;
  const columns = Math.min(4, Math.max(1, assets.length));
  const rows = Math.max(1, Math.ceil(assets.length / columns));
  const canvas = makeCanvas(columns * cell, rows * cell);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context could not be created.');

  ctx.fillStyle = '#f7f7f4';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = '#2b2b2b';
  ctx.textAlign = 'center';
  ctx.imageSmoothingEnabled = !(settings.pixelArtMode || settings.resizeMethod === 'nearest');
  if (ctx.imageSmoothingEnabled) ctx.imageSmoothingQuality = 'high';

  assets.forEach((asset, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const x = col * cell;
    const y = row * cell;
    const size = 112;
    ctx.drawImage(asset.canvas, x + 24, y + 14, size, size);
    ctx.fillText(asset.fileName, x + cell / 2, y + 145, cell - 16);
  });

  return canvas;
};

const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

const getScaleFactor = (scaleMode: CutterSettings['scaleMode']) => {
  if (scaleMode === 'original') return 1;
  if (scaleMode === '2x') return 2;
  if (scaleMode === '3x') return 3;
  if (scaleMode === '4x') return 4;
  return null;
};

const normalizeSelection = (selection: AssetSelection): AssetSelection => ({
  ...selection,
  x: Math.round(selection.x),
  y: Math.round(selection.y),
  width: Math.max(1, Math.round(selection.width)),
  height: Math.max(1, Math.round(selection.height)),
});

const buildColorForegroundMask = (
  data: Uint8ClampedArray,
  backgroundColor: RGB,
  tolerance: number,
  includeAllOpaque: boolean,
) => {
  const mask = new Uint8Array(data.length / 4);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    const index = pixel * 4;
    mask[pixel] = includeAllOpaque
      ? data[index + 3] > 8 ? 1 : 0
      : colorDistance(data, index, backgroundColor) > tolerance && data[index + 3] > 8 ? 1 : 0;
  }
  return mask;
};

const buildEdgeForegroundMask = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  backgroundColor: RGB,
  tolerance: number,
) => {
  const background = new Uint8Array(width * height);
  const queue: number[] = [];
  let head = 0;

  const enqueue = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const pixel = y * width + x;
    if (background[pixel]) return;
    const index = pixel * 4;
    if (colorDistance(data, index, backgroundColor) > tolerance) return;
    background[pixel] = 1;
    queue.push(pixel);
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  while (head < queue.length) {
    const pixel = queue[head];
    head += 1;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    enqueue(x + 1, y);
    enqueue(x - 1, y);
    enqueue(x, y + 1);
    enqueue(x, y - 1);
  }

  const mask = new Uint8Array(width * height);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    mask[pixel] = !background[pixel] && data[pixel * 4 + 3] > 8 ? 1 : 0;
  }
  return mask;
};

const findConnectedBoxes = (
  mask: Uint8Array,
  width: number,
  height: number,
  minArea: number,
): OpaqueBounds[] => {
  const visited = new Uint8Array(mask.length);
  const boxes: OpaqueBounds[] = [];
  const queue: number[] = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    queue.length = 0;
    queue.push(start);
    visited[start] = 1;
    let head = 0;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    while (head < queue.length) {
      const pixel = queue[head];
      head += 1;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      area += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      const neighbors = [pixel + 1, pixel - 1, pixel + width, pixel - width];
      for (const next of neighbors) {
        if (next < 0 || next >= mask.length || visited[next] || !mask[next]) continue;
        const nx = next % width;
        if (Math.abs(nx - x) > 1) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }

    if (area >= minArea) {
      boxes.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
    }
  }

  return boxes;
};

const mergeBoxes = (boxes: OpaqueBounds[], distance: number) => {
  const result = [...boxes];
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < result.length; i += 1) {
      for (let j = i + 1; j < result.length; j += 1) {
        if (!boxesNear(result[i], result[j], distance)) continue;
        result[i] = unionBox(result[i], result[j]);
        result.splice(j, 1);
        merged = true;
        break;
      }
      if (merged) break;
    }
  }
  return result;
};

const boxesNear = (a: OpaqueBounds, b: OpaqueBounds, distance: number) => (
  a.x - distance <= b.x + b.width &&
  a.x + a.width + distance >= b.x &&
  a.y - distance <= b.y + b.height &&
  a.y + a.height + distance >= b.y
);

const unionBox = (a: OpaqueBounds, b: OpaqueBounds): OpaqueBounds => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
};

const padBox = (box: OpaqueBounds, padding: number, width: number, height: number): OpaqueBounds => {
  const x = Math.max(0, box.x - padding);
  const y = Math.max(0, box.y - padding);
  const right = Math.min(width, box.x + box.width + padding);
  const bottom = Math.min(height, box.y + box.height + padding);
  return { x, y, width: right - x, height: bottom - y };
};
